package names

import (
	"strings"
	"testing"
)

func TestNamesThatLookAlikeAreTheSame(t *testing.T) {
	for _, pair := range [][2]string{
		{"lee@example.invalid", "lee@example.invalid"},
		{"lee@example.invalid", "LEE@example.invalid"},
		{"lee@example.invalid", " lee@example.invalid  "},
		{"lee kim", "lee  kim"},
		{"lee kim", "leekim"},
		{"lee@example.invalid", "lee@example.invalid\u034f"},
		{"lee@example.invalid", "l\u200bee@example.invalid"},
		{"lee@example.invalid", "lee@example.invalid\ufe00"},
		{"lee@example.invalid", "lee@example.invalid\U000e0100"},
		{"lee@example.invalid", "lee@example.invalid\u3164\u3164"},
		{"lee@example.invalid", "lee@example.invalid\u2800"},
		{"lee@example.invalid", "l\u0435\u0435@example.invalid"},
		{"lee@example.invalid", "\u217cee@example.invalid"},
		{"lee@example.invalid", "\U0001d695ee@example.invalid"},
		{"lee@example.invalid", "Iee@example.invalid"},
		{"mary@example.invalid", "\u217fary@example.invalid"},
		{"mary@example.invalid", "rnary@example.invalid"},
		{"alice@example.invalid", "\u0251lice@example.invalid"},
		{"\u03bd\u03b9\u03ba\u03bf\u03c2", "\u03bd\u03b9\u03ba\u03bf\u03c2\u200d"},
		{"jos\u00e9", "jose\u0301"},
	} {
		if !Same(pair[0], pair[1]) {
			t.Errorf("Same(%+q, %+q) = false, want true", pair[0], pair[1])
		}
	}
}

func TestNamesThatLookDifferentAreNot(t *testing.T) {
	for _, pair := range [][2]string{
		{"lee@example.invalid", "kim@example.invalid"},
		{"lee@example.invalid", "lea@example.invalid"},
		{"jos\u00e9", "jose"},
		{"", ""},
		{" ", "\u200b"},
	} {
		if Same(pair[0], pair[1]) {
			t.Errorf("Same(%+q, %+q) = true, want false", pair[0], pair[1])
		}
	}
}

func TestWidthCountsWideCharactersTwice(t *testing.T) {
	for name, want := range map[string]int{
		"lee@example.invalid":   19,
		"\uff37\uff37":          4,
		"\u3164":                2,
		"\u65e5\u672c":          4,
		"e\u0301":               2,
		strings.Repeat("a", 80): 80,
	} {
		if got := Width(name); got != want {
			t.Errorf("Width(%+q) = %d, want %d", name, got, want)
		}
	}
}

func TestTruncateKeepsWholeCharactersWithinTheWidth(t *testing.T) {
	for _, tc := range []struct {
		name string
		cols int
		want string
	}{
		{"lee@example.invalid", 80, "lee@example.invalid"},
		{strings.Repeat("a", 90), 80, strings.Repeat("a", 80)},
		{strings.Repeat("\uff37", 50), 80, strings.Repeat("\uff37", 40)},
		{"a" + strings.Repeat("\uff37", 50), 80, "a" + strings.Repeat("\uff37", 39)},
	} {
		if got := Truncate(tc.name, tc.cols); got != tc.want {
			t.Errorf("Truncate(%+q, %d) = %+q, want %+q", tc.name, tc.cols, got, tc.want)
		}
	}
}
