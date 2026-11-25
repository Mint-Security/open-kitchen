package syncer

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type Client struct {
	Address string
	APIKey  string
}

func (c Client) Request(ctx context.Context, method, path string, body, result any) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Address+"/rest/"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("sync API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("sync API %s %s: %s", method, path, resp.Status)
	}
	if result != nil {
		// Bounded, but well past the config of a team flooded through a leaked
		// invite: at 4 MiB, a few thousand joins left nothing that could remove them.
		return json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(result)
	}
	return nil
}

func (c Client) Ping(ctx context.Context) error {
	return c.Request(ctx, "GET", "system/ping", nil, nil)
}

func (c Client) AddDevice(ctx context.Context, id, name string, introducer bool, addresses []string) error {
	var device map[string]any
	if err := c.Request(ctx, "GET", "config/defaults/device", nil, &device); err != nil {
		return err
	}
	if len(addresses) == 0 {
		addresses = []string{"dynamic"}
	}
	device["deviceID"], device["name"] = id, name
	device["introducer"], device["autoAcceptFolders"] = introducer, false
	device["addresses"] = addresses
	return c.Request(ctx, "POST", "config/devices", device, nil)
}

func (c Client) ConfigureFolder(ctx context.Context, id, name, path, ownID string) error {
	var folder map[string]any
	if err := c.Request(ctx, "GET", "config/defaults/folder", nil, &folder); err != nil {
		return err
	}
	folder["id"], folder["label"], folder["path"] = id, name, path
	folder["devices"] = []map[string]string{{"deviceID": ownID}}
	folder["rescanIntervalS"], folder["fsWatcherDelayS"] = 60, 1
	if err := c.Request(ctx, "POST", "config/folders", folder, nil); err != nil {
		return err
	}
	ignorePath := "db/ignores?folder=" + url.QueryEscape(id)
	var existing struct {
		Ignore []string `json:"ignore"`
	}
	if err := c.Request(ctx, "GET", ignorePath, nil, &existing); err != nil {
		return err
	}
	return c.Request(ctx, "POST", ignorePath, map[string]any{"ignore": managedIgnores(existing.Ignore)}, nil)
}

func managedIgnores(existing []string) []string {
	var ignore []string
	for len(existing) > 0 {
		line := strings.TrimSpace(existing[0])
		if line != "" && !strings.HasPrefix(line, "//") && !strings.HasPrefix(line, "#escape=") {
			break
		}
		ignore, existing = append(ignore, existing[0]), existing[1:]
	}
	// Keep escape directives first, but exclude staging files before any user negations.
	ignore = append(ignore, "/.commonmind-tmp", "/.commonmind-write-probe")
	for _, pattern := range existing {
		if pattern != "/.commonmind-tmp" && pattern != "/.commonmind-write-probe" {
			ignore = append(ignore, pattern)
		}
	}
	return ignore
}

func (c Client) Share(ctx context.Context, folderID, deviceID string) error {
	path := "config/folders/" + url.PathEscape(folderID)
	var folder struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := c.Request(ctx, "GET", path, nil, &folder); err != nil {
		return err
	}
	for _, d := range folder.Devices {
		if d["deviceID"] == deviceID {
			return nil
		}
	}
	folder.Devices = append(folder.Devices, map[string]any{"deviceID": deviceID})
	return c.Request(ctx, "PATCH", path, folder, nil)
}

// The caller serializes updates. Add the device and folder access in one configuration
// write so interrupted enrollment needs no separate recovery state.
func (c Client) Authorize(ctx context.Context, folderID, deviceID, name string) error {
	var config map[string]json.RawMessage
	if err := c.Request(ctx, "GET", "config", nil, &config); err != nil {
		return err
	}
	var devices, folders []map[string]json.RawMessage
	if err := json.Unmarshal(config["devices"], &devices); err != nil {
		return err
	}
	if err := json.Unmarshal(config["folders"], &folders); err != nil {
		return err
	}
	idJSON, _ := json.Marshal(deviceID)
	folderJSON, _ := json.Marshal(folderID)
	deviceExists := false
	for _, device := range devices {
		deviceExists = deviceExists || bytes.Equal(device["deviceID"], idJSON)
	}
	if !deviceExists {
		var device map[string]json.RawMessage
		if err := c.Request(ctx, "GET", "config/defaults/device", nil, &device); err != nil {
			return err
		}
		device["deviceID"] = idJSON
		device["name"], _ = json.Marshal(name)
		device["introducer"], device["autoAcceptFolders"] = json.RawMessage("false"), json.RawMessage("false")
		device["addresses"] = json.RawMessage(`["dynamic"]`)
		devices = append(devices, device)
	}
	for _, folder := range folders {
		if !bytes.Equal(folder["id"], folderJSON) {
			continue
		}
		var shared []map[string]json.RawMessage
		if err := json.Unmarshal(folder["devices"], &shared); err != nil {
			return err
		}
		for _, device := range shared {
			if bytes.Equal(device["deviceID"], idJSON) && deviceExists {
				return nil
			}
		}
		shared = append(shared, map[string]json.RawMessage{"deviceID": idJSON})
		folder["devices"], _ = json.Marshal(shared)
		config["devices"], _ = json.Marshal(devices)
		config["folders"], _ = json.Marshal(folders)
		return c.Request(ctx, "PUT", "config", config, nil)
	}
	return fmt.Errorf("team folder %q is missing from sync configuration", folderID)
}

// Remove takes a device out of every folder and the device list in one
// configuration write, the reverse of Authorize. The caller serializes updates.
// Devices this one introduced it to drop it once they hear the change.
func (c Client) Remove(ctx context.Context, deviceID string) error {
	var config map[string]json.RawMessage
	if err := c.Request(ctx, "GET", "config", nil, &config); err != nil {
		return err
	}
	var devices, folders []map[string]json.RawMessage
	if err := json.Unmarshal(config["devices"], &devices); err != nil {
		return err
	}
	if err := json.Unmarshal(config["folders"], &folders); err != nil {
		return err
	}
	idJSON, _ := json.Marshal(deviceID)
	isRemoved := func(device map[string]json.RawMessage) bool { return bytes.Equal(device["deviceID"], idJSON) }
	devices = slices.DeleteFunc(devices, isRemoved)
	for _, folder := range folders {
		var shared []map[string]json.RawMessage
		if err := json.Unmarshal(folder["devices"], &shared); err != nil {
			return err
		}
		folder["devices"], _ = json.Marshal(slices.DeleteFunc(shared, isRemoved))
	}
	config["devices"], _ = json.Marshal(devices)
	config["folders"], _ = json.Marshal(folders)
	return c.Request(ctx, "PUT", "config", config, nil)
}

type Member struct {
	DeviceID  string
	Name      string
	Connected bool
	LastSeen  time.Time
}

// Members lists the devices the team folder is shared with, this one included,
// by name. LastSeen is zero for a device that has never connected.
func (c Client) Members(ctx context.Context, folderID string) ([]Member, error) {
	var config struct {
		Devices []struct {
			DeviceID string `json:"deviceID"`
			Name     string `json:"name"`
		} `json:"devices"`
		Folders []struct {
			ID      string `json:"id"`
			Devices []struct {
				DeviceID string `json:"deviceID"`
			} `json:"devices"`
		} `json:"folders"`
	}
	if err := c.Request(ctx, "GET", "config", nil, &config); err != nil {
		return nil, err
	}
	var state struct {
		Connections map[string]struct {
			Connected bool `json:"connected"`
		} `json:"connections"`
	}
	if err := c.Request(ctx, "GET", "system/connections", nil, &state); err != nil {
		return nil, err
	}
	var stats map[string]struct {
		LastSeen time.Time `json:"lastSeen"`
	}
	if err := c.Request(ctx, "GET", "stats/device", nil, &stats); err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, device := range config.Devices {
		names[device.DeviceID] = device.Name
	}
	var members []Member
	for _, folder := range config.Folders {
		if folder.ID != folderID {
			continue
		}
		for _, device := range folder.Devices {
			m := Member{DeviceID: device.DeviceID, Name: names[device.DeviceID], Connected: state.Connections[device.DeviceID].Connected}
			if seen := stats[device.DeviceID].LastSeen; seen.Unix() > 0 {
				m.LastSeen = seen
			}
			members = append(members, m)
		}
	}
	slices.SortFunc(members, func(a, b Member) int {
		return cmp.Or(strings.Compare(a.Name, b.Name), strings.Compare(a.DeviceID, b.DeviceID))
	})
	return members, nil
}

type Pending struct {
	Name string    `json:"name"`
	Time time.Time `json:"time"`
}

func (c Client) Pending(ctx context.Context) (map[string]Pending, error) {
	var pending map[string]Pending
	err := c.Request(ctx, "GET", "cluster/pending/devices", nil, &pending)
	return pending, err
}

func (c Client) Connected(ctx context.Context, id string) (bool, error) {
	var state struct {
		Connections map[string]struct {
			Connected bool `json:"connected"`
		} `json:"connections"`
	}
	err := c.Request(ctx, "GET", "system/connections", nil, &state)
	return state.Connections[id].Connected, err
}

func (c Client) Summary(ctx context.Context, folderID string) (string, error) {
	var state struct {
		Connections map[string]struct {
			Connected bool `json:"connected"`
		} `json:"connections"`
	}
	if err := c.Request(ctx, "GET", "system/connections", nil, &state); err != nil {
		return "", err
	}
	connected := 0
	for _, d := range state.Connections {
		if d.Connected {
			connected++
		}
	}
	var folder struct {
		State     string `json:"state"`
		NeedItems int    `json:"needTotalItems"`
		Errors    int    `json:"pullErrors"`
	}
	if err := c.Request(ctx, "GET", "db/status?folder="+url.QueryEscape(folderID), nil, &folder); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d teammates connected; %s; %d items pending; %d sync errors", connected, folder.State, folder.NeedItems, folder.Errors), nil
}
