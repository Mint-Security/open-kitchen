package store

import "testing"

// TestGetMatchesTheWholeSessionID: session ids are dash-separated, and so is
// the published file name ("<session-id>-<source-hash>.cms"), so an id that
// is the leading part of another one names a different session, not both.
func TestGetMatchesTheWholeSessionID(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "0198e3c1", "the short one")
	publish(t, st, "a@b.c", "0198e3c1-abcd-4ef0-9a12-abcdef123456", "the long one")

	hits, err := st.Get("0198e3c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].SessionID != "0198e3c1" {
		ids := make([]string, 0, len(hits))
		for _, hit := range hits {
			ids = append(ids, hit.SessionID)
		}
		t.Fatalf("Get(%q) returned sessions %q; want only that one", "0198e3c1", ids)
	}

	hits, err = st.Get("0198e3c1-abcd-4ef0-9a12-abcdef123456")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].SessionID != "0198e3c1-abcd-4ef0-9a12-abcdef123456" {
		t.Fatalf("Get by the full id returned %d session(s)", len(hits))
	}
}
