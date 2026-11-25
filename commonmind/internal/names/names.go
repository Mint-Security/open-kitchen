// Package names compares the names teammates give their devices the way a
// person reading them would, and measures how much of a terminal they take.
package names

import (
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
	"golang.org/x/text/width"
)

//go:generate sh -c "curl -fsSLO https://www.unicode.org/Public/security/latest/confusables.txt && go run gen.go confusables.txt && rm confusables.txt"

type confusable struct {
	from rune
	to   string
}

// Same reports whether two names would pass for each other on screen: they
// differ only in case, spacing, invisible characters, or characters that
// Unicode lists as drawn alike (the confusables of UTS #39). A name with
// nothing visible in it is not the same as any other.
func Same(a, b string) bool {
	ka, kb := keys(a), keys(b)
	return ka[0] != "" && ka[0] == kb[0] || ka[1] != "" && ka[1] == kb[1]
}

// keys ignores case in two orders, since a letter's look-alike in one case
// is not always one in the other: I passes for l, and i does not.
func keys(name string) [2]string {
	return [2]string{skeleton(strings.ToLower(name)), strings.ToLower(skeleton(name))}
}

// skeleton is UTS #39's: decomposed, without default-ignorable characters, and
// each character replaced by the one it is drawn like. Blanks are dropped too,
// so spacing does not tell two names apart.
func skeleton(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(s) {
		if ignorable(r) {
			continue
		}
		i, found := slices.BinarySearchFunc(confusables[:], r, func(c confusable, r rune) int { return int(c.from - r) })
		if found {
			b.WriteString(confusables[i].to)
		} else {
			b.WriteRune(r)
		}
	}
	return strings.Map(func(r rune) rune {
		if ignorable(r) || unicode.IsSpace(r) || r == '\u2800' {
			return -1
		}
		return r
	}, norm.NFD.String(b.String()))
}

func ignorable(r rune) bool {
	return unicode.In(r, unicode.Cf, unicode.Other_Default_Ignorable_Code_Point, unicode.Variation_Selector)
}

// Width is how many terminal columns a name can take: two for a wide or
// full-width character and one for any other, invisible ones included.
func Width(name string) int {
	n := 0
	for _, r := range name {
		n += runeWidth(r)
	}
	return n
}

// Truncate keeps as much of the start of a name as fits in cols columns.
func Truncate(name string, cols int) string {
	for i, r := range name {
		if cols -= runeWidth(r); cols < 0 {
			return name[:i]
		}
	}
	return name
}

func runeWidth(r rune) int {
	switch width.LookupRune(r).Kind() {
	case width.EastAsianWide, width.EastAsianFullwidth:
		return 2
	}
	return 1
}
