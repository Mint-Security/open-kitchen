package store

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// NoticePrefix starts the name of each of the team creator's membership
// notices. They sit at the top of the shared folder, beside the sessions, so
// that they sync like them.
const NoticePrefix = ".commonmind-notice-"

// maxNotice bounds what is read as one notice; a real one is under 2 KiB.
const maxNotice = 64 << 10

// WriteNotice leaves a notice in the shared folder under a new name that no
// one can know beforehand, so nothing put in the folder ahead of it can stand
// in its way. It goes through this host's staging directory, so a reader sees
// the whole notice or none of it.
func (s *Store) WriteNotice(data []byte) error {
	if err := s.realDir(s.root); err != nil {
		return err
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	final := filepath.Join(s.root, NoticePrefix+hex.EncodeToString(id[:])+".json")
	tmpDir, err := s.StagingDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(tmpDir, "notice-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return fmt.Errorf("write membership notice: %w", err)
	}
	dir, err := os.Open(s.root)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// Notices reads the notices in the shared folder.
func (s *Store) Notices() ([][]byte, error) {
	files, err := s.NoticeFiles()
	if err != nil {
		return nil, err
	}
	var notices [][]byte
	for _, file := range files {
		if data, err := s.ReadNotice(file.Name()); err == nil {
			notices = append(notices, data)
		}
	}
	return notices, nil
}

// NoticeFiles lists the files in the shared folder named as notices. Anyone
// who shares the folder can put something else under a notice's name, so only
// small regular files are listed.
func (s *Store) NoticeFiles() ([]fs.FileInfo, error) {
	if err := s.realDir(s.root); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.root)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var files []fs.FileInfo
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), NoticePrefix) || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && info.Size() <= maxNotice {
			files = append(files, info)
		}
	}
	return files, nil
}

// ReadNotice reads one file NoticeFiles listed.
func (s *Store) ReadNotice(name string) ([]byte, error) {
	file, err := Open(filepath.Join(s.root, filepath.Base(name)))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxNotice+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxNotice {
		return nil, fmt.Errorf("notice %s is over %d bytes", name, maxNotice)
	}
	return data, nil
}
