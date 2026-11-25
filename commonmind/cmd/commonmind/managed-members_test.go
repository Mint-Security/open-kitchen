package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

func inviteIn(t *testing.T, output string) string {
	t.Helper()
	for _, field := range strings.Fields(output) {
		if strings.HasPrefix(field, "cm2_") {
			return field
		}
	}
	t.Fatalf("no invite in:\n%s", output)
	return ""
}

func (m *machine) knows(peer *machine) bool {
	var device map[string]any
	return m.Request(m.lab.ctx, "GET", "config/devices/"+peer.DeviceID, nil, &device) == nil
}

func noticeFiles(shared string) []string {
	files, _ := filepath.Glob(filepath.Join(shared, store.NoticePrefix+"*.json"))
	return files
}

// standing is the creator's latest notice about a device in m's shared folder.
func (m *machine) standing(device string) (syncer.Notice, bool) {
	s := m.settings()
	notices, _ := store.New(s.SharedDir).Notices()
	notice, ok := syncer.CurrentNotices(notices, s.OwnerID, s.FolderID)[device]
	return notice, ok
}

// TestManagedCLIAnOutOfDateTeammateHearsOfARemovalFromAnyone: Lee is offline
// while Dana removes Sam, and comes back while Dana is offline, meeting only
// Sam and Kim. Kim's folder has lost the notice in between, and Kim has put
// back its own copy. Lee drops Sam once Kim passes the removal on, so what Kim
// writes next does not reach Sam through Lee.
func TestManagedCLIAnOutOfDateTeammateHearsOfARemovalFromAnyone(t *testing.T) {
	lab := newManagedLab(t, 5*time.Minute)
	t.Parallel()
	dana, sam, lee, kim := lab.machine("dana"), lab.machine("sam"), lab.machine("lee"), lab.machine("kim")
	dana.cli("init", "--team", "Lab", "--clients", "none", "--no-service", "--author", "dana@example.invalid", "--syncthing", lab.syncBin)
	danaAddress := dana.startDaemon()
	invite := inviteIn(t, dana.cli("invite", "--no-wait"))
	teammates := []*machine{sam, lee, kim}
	addresses := map[*machine]string{}
	for _, m := range teammates {
		m.cli("join", "--clients", "none", "--no-service", "--author", m.name+"@example.invalid", "--syncthing", lab.syncBin, invite)
		addresses[m] = m.startDaemon()
		m.reach(dana, danaAddress)
		lab.wait(m.name+"'s enrollment", func() bool { return m.settings().Enrolled })
	}
	for _, m := range teammates {
		for _, peer := range teammates {
			if peer != m {
				lab.wait("Dana to introduce "+peer.name+" to "+m.name, func() bool { return m.knows(peer) })
				m.reach(peer, addresses[peer])
			}
		}
	}
	lab.wait("Lee to connect to Sam and Kim", func() bool {
		toSam, _ := lee.Connected(lab.ctx, sam.DeviceID)
		toKim, _ := lee.Connected(lab.ctx, kim.DeviceID)
		return toSam && toKim
	})

	lee.stopDaemon()
	dana.cli("remove", "sam@example.invalid")
	lab.wait("Kim to drop Sam", func() bool { return !kim.knows(sam) })
	folder := dana.settings().FolderID
	if err := dana.Request(lab.ctx, "POST", "db/scan?folder="+folder, nil, nil); err != nil {
		t.Fatal(err)
	}
	lab.wait("Kim to have everything Dana has", func() bool {
		var completion struct {
			Completion float64 `json:"completion"`
			NeedItems  int     `json:"needItems"`
		}
		err := dana.Request(lab.ctx, "GET", "db/completion?folder="+folder+"&device="+kim.DeviceID, nil, &completion)
		return err == nil && completion.Completion == 100 && completion.NeedItems == 0
	})

	dana.stopDaemon()

	// Kim's folder loses the notice, and Kim puts back the copy it kept.
	kimShared, leeShared, samShared := kim.settings().SharedDir, lee.settings().SharedDir, sam.settings().SharedDir
	lab.wait("Kim to keep the notice", func() bool { _, err := os.Stat(filepath.Join(kim.home, "notices.json")); return err == nil })
	for _, notice := range noticeFiles(kimShared) {
		if err := os.Remove(notice); err != nil {
			t.Fatal(err)
		}
	}
	lab.wait("Kim to put the notice back", func() bool { return len(noticeFiles(kimShared)) > 0 })

	lee.startDaemon()
	lab.wait("Lee to drop Sam without hearing from Dana", func() bool { return !lee.knows(sam) })
	if connected, _ := lee.Connected(lab.ctx, dana.DeviceID); connected {
		t.Fatal("Lee reached Dana, who is offline")
	}

	if err := os.WriteFile(filepath.Join(kimShared, "after-removal.txt"), []byte("new since the removal"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := kim.Request(lab.ctx, "POST", "db/scan?folder="+folder, nil, nil); err != nil {
		t.Fatal(err)
	}
	lab.wait("Kim's new file to reach Lee", func() bool {
		_, err := os.Stat(filepath.Join(leeShared, "after-removal.txt"))
		return err == nil
	})
	if _, err := os.Stat(filepath.Join(samShared, "after-removal.txt")); err == nil {
		t.Fatal("Kim's new file reached Sam after the removal")
	}
}

// TestManagedCLIRemovingATeammate: Dana's team has Sam and Lee, who sync with
// each other. Dana removes Sam. Lee drops Sam on its own, and the invite Sam
// joined with no longer lets anyone in. A new invite brings Sam back.
func TestManagedCLIRemovingATeammate(t *testing.T) {
	lab := newManagedLab(t, 5*time.Minute)
	t.Parallel()
	dana, sam, lee := lab.machine("dana"), lab.machine("sam"), lab.machine("lee")
	dana.cli("init", "--team", "Lab", "--clients", "none", "--no-service", "--author", "dana@example.invalid", "--syncthing", lab.syncBin)
	danaAddress := dana.startDaemon()
	danaDaemon := dana.daemon
	invite := inviteIn(t, dana.cli("invite", "--no-wait"))
	addresses := map[*machine]string{}
	for _, m := range []*machine{sam, lee} {
		m.cli("join", "--clients", "none", "--no-service", "--author", m.name+"@example.invalid", "--syncthing", lab.syncBin, invite)
		addresses[m] = m.startDaemon()
		m.reach(dana, danaAddress)
		lab.wait(m.name+"'s enrollment", func() bool { return m.settings().Enrolled })
	}
	lab.wait("Dana to introduce Sam to Lee", func() bool { return strings.Contains(lee.cli("members"), "sam@example.invalid") })
	lee.reach(sam, addresses[sam])
	sam.reach(lee, addresses[lee])
	lab.wait("Sam and Lee to connect", func() bool { connected, _ := lee.Connected(lab.ctx, sam.DeviceID); return connected })

	listed := dana.cli("members")
	for _, want := range []string{"dana@example.invalid", "sam@example.invalid", "lee@example.invalid", "this device"} {
		if !strings.Contains(listed, want) {
			t.Fatalf("dana's members has no %q:\n%s", want, listed)
		}
	}
	if !strings.Contains(lee.cli("members"), "team creator") {
		t.Fatal("lee's members does not say which device created the team")
	}
	if output, err := runBinary(lab.ctx, lab.exe, lee.env, "remove", "sam@example.invalid"); err == nil || !strings.Contains(output, "only the team creator") {
		t.Fatalf("a member removed a device: %v\n%s", err, output)
	}

	removed := dana.cli("remove", "sam@example.invalid")
	if !strings.Contains(removed, "Removed sam@example.invalid") || !strings.Contains(removed, "Cancelled the open invite") {
		t.Fatalf("remove said:\n%s", removed)
	}
	if strings.Contains(dana.cli("members"), "sam@example.invalid") {
		t.Fatal("dana still lists sam")
	}
	if notice, ok := dana.standing(sam.DeviceID); !ok || !notice.Removed {
		t.Fatalf("dana's standing notice about sam is %+v, %v; want the removal", notice, ok)
	}
	lab.wait("Lee to drop Sam", func() bool { return !strings.Contains(lee.cli("members"), "sam@example.invalid") })
	lab.wait("Sam to be cut off", func() bool {
		toDana, _ := dana.Connected(lab.ctx, sam.DeviceID)
		toLee, _ := lee.Connected(lab.ctx, sam.DeviceID)
		return !toDana && !toLee
	})

	// A new device with the invite Sam joined with asks Dana to let it in.
	again := lab.machine("sam-again")
	again.cli("join", "--clients", "none", "--no-service", "--author", "sam@example.invalid", "--syncthing", lab.syncBin, invite)
	again.startDaemon()
	again.reach(dana, danaAddress)
	lab.wait("the request to reach Dana", func() bool {
		pending, _ := dana.Pending(lab.ctx)
		_, asked := pending[again.DeviceID]
		return asked
	})
	dana.cli("approve")
	if strings.Contains(dana.cli("members"), again.DeviceID[:7]) || again.settings().Enrolled {
		t.Fatal("the cancelled invite let a new device in")
	}

	// Dana lets Sam back in with a new invite, which Sam runs on the same
	// machine. Sam's Syncthing retries Dana every two seconds instead of every
	// minute, to keep the test short.
	if err := sam.Request(lab.ctx, "PATCH", "config/options", map[string]any{"reconnectionIntervalS": 2}, nil); err != nil {
		t.Fatal(err)
	}
	if output := sam.cli("join", "--clients", "none", "--no-service", inviteIn(t, dana.cli("invite", "--no-wait"))); !strings.Contains(output, "Already joined") {
		t.Fatalf("join on Sam's machine said:\n%s", output)
	}
	lab.wait("Dana to let Sam back in", func() bool { return strings.Contains(dana.cli("members"), sam.DeviceID[:7]) })
	lab.wait("Sam's device to go back to its own name", func() bool {
		var device struct {
			Name string `json:"name"`
		}
		return sam.Request(lab.ctx, "GET", "config/devices/"+sam.DeviceID, nil, &device) == nil && device.Name == "sam@example.invalid"
	})
	if notice, ok := dana.standing(sam.DeviceID); !ok || notice.Removed {
		t.Fatalf("dana's standing notice about sam is %+v, %v; want the readmission", notice, ok)
	}
	lab.wait("Lee to know Sam again", func() bool { return lee.knows(sam) })

	dana.stopDaemon()
	<-danaDaemon.exited
	for _, name := range []string{"sam@example.invalid", "lee@example.invalid"} {
		if !strings.Contains(danaDaemon.stderr.String(), "accepted "+name) {
			t.Fatalf("dana's daemon log does not record that %s joined:\n%s", name, danaDaemon.stderr.String())
		}
	}
}
