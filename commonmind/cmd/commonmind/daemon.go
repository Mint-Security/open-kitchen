package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

// restoreOwnName gives this device its author name back once the creator has
// it. join puts a proof in its place when an enrolled device is invited again,
// for the creator to let it back in if it was removed.
func restoreOwnName(ctx context.Context, state syncer.State, s settings.Settings) error {
	var device struct {
		Name string `json:"name"`
	}
	if err := state.Request(ctx, "GET", "config/devices/"+state.DeviceID, nil, &device); err != nil || device.Name == s.Author {
		return err
	}
	if connected, err := state.Connected(ctx, s.OwnerID); err != nil || !connected {
		return err
	}
	return state.Request(ctx, "PATCH", "config/devices/"+state.DeviceID, map[string]any{"name": s.Author}, nil)
}

// noticeFile is what the daemon read from one notice file in the shared folder:
// the file as it was, and the notice it held, as SignNotice wrote it, or nil.
type noticeFile struct {
	info   fs.FileInfo
	notice []byte
}

// readNotices returns the notices in the shared folder, each once, and what it
// read from each file. A file it read before that is still the same file, with
// the same size and modification time, is not read again, so however many
// copies anyone puts in the folder, each costs one read.
func readNotices(shared *store.Store, before map[string]noticeFile, check func([]byte) ([]byte, error)) ([][]byte, map[string]noticeFile, error) {
	files, err := shared.NoticeFiles()
	if err != nil {
		return nil, before, err
	}
	after := make(map[string]noticeFile, len(files))
	var notices [][]byte
	for _, info := range files {
		file, ok := before[info.Name()]
		if !ok || !os.SameFile(file.info, info) || file.info.Size() != info.Size() || !file.info.ModTime().Equal(info.ModTime()) {
			data, err := shared.ReadNotice(info.Name())
			if err != nil {
				continue
			}
			file = noticeFile{info: info}
			if notice, err := check(data); err == nil {
				file.notice = notice
			}
		}
		after[info.Name()] = file
		if file.notice != nil && !slices.ContainsFunc(notices, func(n []byte) bool { return bytes.Equal(n, file.notice) }) {
			notices = append(notices, file.notice)
		}
	}
	return notices, after, nil
}

// keepNotices keeps the creator's latest notice about each device that reaches
// this machine, in notices.json in its home, and puts back in the shared folder
// any it has lost. It returns every notice it keeps, and what it read from the
// folder for the next pass.
func keepNotices(home string, s settings.Settings, files map[string]noticeFile) ([][]byte, map[string]noticeFile, error) {
	shared := store.New(s.SharedDir)
	inFolder, files, err := readNotices(shared, files, func(data []byte) ([]byte, error) {
		return syncer.CanonicalNotice(data, s.OwnerID, s.FolderID)
	})
	if err != nil {
		return nil, files, err
	}
	path := filepath.Join(home, "notices.json")
	var held [][]byte
	if err := readState(path, &held); err != nil {
		return nil, files, err
	}
	kept, missing := syncer.KeepNotices(held, inFolder, s.OwnerID, s.FolderID)
	for _, data := range missing {
		if err := shared.WriteNotice(data); err != nil {
			return nil, files, err
		}
		fmt.Fprintln(os.Stderr, "removal: put back a notice the shared folder lost")
	}
	if !slices.EqualFunc(kept, held, bytes.Equal) {
		if err := writeState(home, path, kept); err != nil {
			return nil, files, err
		}
	}
	return kept, files, nil
}

// applyRemovals acts on the creator's removal notices that reached this
// machine through the shared folder. Connected to the creator, it leaves the
// device to Syncthing, which follows the creator's own list, and only notes the
// notice. Cut off from the creator, it drops the device itself. It acts on each
// notice once: letting the device back in later is the creator's call.
func applyRemovals(ctx context.Context, home string, state syncer.State, s settings.Settings, notices [][]byte) error {
	path := filepath.Join(home, "removals.json")
	seen := map[string]int64{}
	if err := readState(path, &seen); err != nil {
		return err
	}
	unseen := syncer.UnseenRemovals(notices, s.OwnerID, s.FolderID, state.DeviceID, seen)
	if len(unseen) == 0 {
		return nil
	}
	connected, err := state.Connected(ctx, s.OwnerID)
	if err != nil {
		return err
	}
	for _, n := range unseen {
		if !connected {
			if err := state.Remove(ctx, n.Device); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "removal: dropped %s, which the team creator removed\n", shortID(n.Device))
		}
		seen[n.Device] = n.At
	}
	return writeState(home, path, seen)
}

// readState reads a JSON file the daemon keeps in its home into v, leaving v
// as it is when there is no file yet.
func readState(path string, v any) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	return nil
}

func writeState(home, path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(home, "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func cmdDaemon(ctx context.Context, out io.Writer) error {
	_, state, err := managedState()
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	lock, err := syncer.Lock(home)
	if err != nil {
		return err
	}
	defer lock.Close()
	process, err := state.Start(ctx)
	if err != nil {
		return err
	}
	defer process.Close()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var lastPublish time.Time
	var noticeFiles map[string]noticeFile
	for {
		s, err := settings.Load()
		if err != nil {
			return err
		}
		if s.OwnerID == state.DeviceID {
			pending, err := state.Pending(ctx)
			if err == nil {
				invites := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: s.OwnerID}
				var joined []syncer.Joined
				joined, err = invites.Process(ctx, state.Client, pending, time.Now())
				for _, j := range joined {
					fmt.Fprintf(os.Stderr, "enrollment: accepted %s (%s)\n", displayName(j.Name), shortID(j.DeviceID))
					if err := announce(home, s, j.DeviceID, false); err != nil {
						fmt.Fprintln(os.Stderr, "enrollment:", err)
					}
				}
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "enrollment:", err)
			}
		}
		if s.Enrolled {
			var notices [][]byte
			notices, noticeFiles, err = keepNotices(home, s, noticeFiles)
			if err == nil && s.OwnerID != state.DeviceID {
				err = applyRemovals(ctx, home, state, s, notices)
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "removal:", err)
			}
		}
		if !s.Enrolled {
			connected, err := state.Connected(ctx, s.OwnerID)
			if err != nil {
				return err
			}
			if connected {
				var completion struct {
					RemoteState string `json:"remoteState"`
				}
				err := state.Request(ctx, "GET", "db/completion?folder="+url.QueryEscape(s.FolderID)+"&device="+url.QueryEscape(s.OwnerID), nil, &completion)
				if err != nil {
					return err
				}
				if completion.RemoteState == "valid" {
					if err := state.Request(ctx, "PATCH", "config/devices/"+state.DeviceID, map[string]any{"name": s.Author}, nil); err != nil {
						return err
					}
					s.Enrolled = true
					if err := settings.Save(s); err != nil {
						return err
					}
				}
			}
		}
		if s.Enrolled && time.Since(lastPublish) >= time.Minute {
			lastPublish = time.Now()
			if s.OwnerID != state.DeviceID {
				if err := restoreOwnName(ctx, state, s); err != nil {
					fmt.Fprintln(os.Stderr, "enrollment:", err)
				}
			}
			publishErr := cmdFlush(ctx, nil, io.Discard)
			report := map[string]any{"last_attempt": lastPublish.UTC(), "error": ""}
			if publishErr != nil {
				report["error"] = publishErr.Error()
				fmt.Fprintln(os.Stderr, "publish:", publishErr)
			}
			data, _ := json.Marshal(report)
			if err := os.WriteFile(filepath.Join(home, "publish-status.json"), data, 0o600); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case err := <-process.Done():
			return fmt.Errorf("sync process exited: %v", err)
		case <-ticker.C:
		}
	}
}
