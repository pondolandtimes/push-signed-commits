package main

import "testing"

func TestCutCommitMessage(t *testing.T) {
	for _, tc := range []struct {
		what    string
		message string
		subject string
		body    string
	}{
		{
			what:    "empty",
			message: "",
			subject: "",
			body:    "",
		},
		{
			what:    "subject only",
			message: "subject",
			subject: "subject",
			body:    "",
		},
		{
			what:    "subject and body",
			message: "subject\n\nbody",
			subject: "subject",
			body:    "body",
		},
		{
			what:    "two-line subject and body",
			message: "subject\nsubject2\n\nbody\nbody2",
			subject: "subject\nsubject2",
			body:    "body\nbody2",
		},
		{
			what:    "three-line subject and body",
			message: "subject\nsubject2\nsubject3\n\nbody\nbody2\nbody3",
			subject: "subject\nsubject2\nsubject3",
			body:    "body\nbody2\nbody3",
		},
		{
			what:    "three-line subject and body with insignificant newlines",
			message: "\n\nsubject\nsubject2\nsubject3\n\n\n\nbody\nbody2\nbody3\n\n",
			subject: "subject\nsubject2\nsubject3",
			body:    "body\nbody2\nbody3",
		},
		{
			what:    "three-line subject and body with insignificant newlines and whitespace",
			message: "  \t \n   \nsubject\nsubject2\nsubject3\n \f  \n  \v \n\nbody\nbody2\nbody3\n \r  \n",
			subject: "subject\nsubject2\nsubject3",
			body:    "body\nbody2\nbody3",
		},
		{
			what:    "three-line subject and body with insignificant newlines and whitespace, and significant whitespace",
			message: "  \t \n   \nsubject\n   subject2\nsubject3\n \f  \n  \v \n\nbody\n  body2\nbody3\n \r  \n",
			subject: "subject\n   subject2\nsubject3",
			body:    "body\n  body2\nbody3",
		},
	} {
		subject, body := CutCommitMessage(tc.message)
		if tc.subject != subject || tc.body != body {
			t.Errorf("formatCommitMessage(%q) - %s\n\texpected\n\t\tsubject %q\n\t\tbody %q\n\tgot\n\t\tsubject %q\n\t\tbody %q", tc.message, tc.what, tc.subject, tc.body, subject, body)
		}
	}
}

func TestTrimBlankLinesStart(t *testing.T) {
	for _, tc := range []struct {
		what string
		in   string
		out  string
	}{
		{"empty", "", ""},
		{"one newline", "\n", ""},
		{"all newline", "\n\n\n", ""},
		{"no newline", "test", "test"},
		{"no newline all spaces", "   ", "   "},
		{"no blank lines", "test\ntest", "test\ntest"},
		{"leading and trailing newline", "\ntest\ntest\n", "test\ntest\n"},
		{"leading and trailing newlines", "\n\ntest\ntest\n\n", "test\ntest\n\n"},
		{"ascii whitespace", "\n \t\r\v \ntest\n \t\r\v \n", "test\n \t\r\v \n"},
		{"blank lines in middle", "test\n\n\ntest", "test\n\n\ntest"},
		{"blank line at start", "\ntest\n", "test\n"},
		{"blank line in middle", "test\n\ntest\n", "test\n\ntest\n"},
		{"blank line at end", "test\n\n", "test\n\n"},
		{"blank line with ascii whitespace", "test\n \t\r\v \ntest", "test\n \t\r\v \ntest"},
	} {
		if got := trimBlankLinesStart(tc.in); got != tc.out {
			t.Errorf("trimBlankLinesStart(%q) - %s\n\texpected %q\n\tgot %q", tc.in, tc.what, tc.out, got)
		}
	}
}
func TestTrimBlankLinesEnd(t *testing.T) {
	for _, tc := range []struct {
		what string
		in   string
		out  string
	}{
		{"empty", "", ""},
		{"one newline", "\n", ""},
		{"all newline", "\n\n\n", ""},
		{"no newline", "test", "test"},
		{"no newline all spaces", "   ", "   "},
		{"no blank lines", "test\ntest", "test\ntest"},
		{"leading and trailing newline", "\ntest\ntest\n", "\ntest\ntest"},
		{"leading and trailing newlines", "\n\ntest\ntest\n\n", "\n\ntest\ntest"},
		{"ascii whitespace", "\n \t\r\v \ntest\n \t\r\v \n", "\n \t\r\v \ntest"},
		{"blank lines in middle", "test\n\n\ntest", "test\n\n\ntest"},
		{"blank line at start", "\ntest\n", "\ntest"},
		{"blank line in middle", "test\n\ntest\n", "test\n\ntest"},
		{"blank line at end", "test\n\n", "test"},
		{"blank line with ascii whitespace", "test\n \t\r\v \ntest", "test\n \t\r\v \ntest"},
	} {
		if got := trimBlankLinesEnd(tc.in); got != tc.out {
			t.Errorf("trimBlankLinesEnd(%q) - %s\n\texpected %q\n\tgot %q", tc.in, tc.what, tc.out, got)
		}
	}
}

func TestCutBlankLine(t *testing.T) {
	for _, tc := range []struct {
		what   string
		in     string
		before string
		after  string
		found  bool
	}{
		{"empty", "", "", "", false},
		{"one newline", "\n", "", "", true},
		{"all newline", "\n\n\n", "", "\n\n", true},
		{"no newline", "test", "test", "", false},
		{"no newline all spaces", "   ", "   ", "", false},
		{"no blank lines", "test\ntest", "test\ntest", "", false},
		{"leading and trailing newline", "\ntest\ntest\n", "", "test\ntest\n", true},
		{"leading and trailing newlines", "\n\ntest\ntest\n\n", "", "\ntest\ntest\n\n", true},
		{"ascii whitespace", "\n \t\r\v \ntest\n \t\r\v \n", "", " \t\r\v \ntest\n \t\r\v \n", true},
		{"blank lines in middle", "test\n\n\ntest", "test\n", "\ntest", true},
		{"blank line at start", "\ntest\n", "", "test\n", true},
		{"blank line in middle", "test\n\ntest\n", "test\n", "test\n", true},
		{"blank line at end", "test\n\n", "test\n", "", true},
		{"blank line with ascii whitespace", "test\n \t\r\v \ntest", "test\n", "test", true},
	} {
		if before, after, found := cutBlankLine(tc.in); before != tc.before || after != tc.after || found != tc.found {
			t.Errorf("cutBlankLine(%q) - %s\n\texpected\n\t\tbefore %q\n\t\tafter %q\n\t\tfound %t\n\tgot\n\t\tbefore %q\n\t\tafter %q\n\t\tfound %t", tc.in, tc.what, tc.before, tc.after, tc.found, before, after, found)
		}
	}
}
