package main

import (
	"cmp"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
)

var (
	Chdir      = flag.String("C", "", "change to a different directory before running the command")
	Git        = flag.String("g", "", "use a different git binary (minimum version "+strconv.Itoa(MinGitMajor)+"."+strconv.Itoa(MinGitMinor)+")")
	DryRun     = flag.Bool("n", false, "do not push commits, just dump the mutations to stdout, one line per commit")
	Insecure   = flag.Bool("k", false, "do not validate ssl certificates")
	Quiet      = flag.Bool("q", false, "do not print status messages to stderr")
	Verbose    = flag.Bool("v", false, "print verbose information to stderr")
	Debug      = flag.Bool("x", false, "print the git commands to stderr")
	Commit     = flag.Bool("commit", false, "commit the staged changes")
	AllowEmpty = flag.Bool("allow-empty", false, "allow an empty commit to be created (only valid with -commit)")
)

var (
	GitHubGraphqlURL = cmp.Or(os.Getenv("GITHUB_GRAPHQL_URL"), DefaultGitHubGraphqlURL)
	GitHubToken      = os.Getenv("GITHUB_TOKEN")
)

func init() {
	flag.CommandLine.Usage = usage
}

func usage() {
	var name string
	if len(os.Args) != 0 {
		name = os.Args[0]
	} else {
		name = "push-signed-commits"
	}
	fmt.Fprintf(flag.CommandLine.Output(), "usage:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  %s [flags] username/repo target_branch rev|rev..rev\n", name)
	fmt.Fprintf(flag.CommandLine.Output(), "  %s [flags] -commit [-allow-empty] username/repo target_branch commit_message\n", name)
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "flags:\n")
	flag.CommandLine.PrintDefaults()
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "env:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  GITHUB_GRAPHQL_URL    github graphql endpoint (default %q)\n", DefaultGitHubGraphqlURL)
	fmt.Fprintf(flag.CommandLine.Output(), "  GITHUB_TOKEN          github token (required if not -n)\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "status:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  0     success\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  1     error\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  2     invalid argument\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  30    not pushing anymore commits due to a commit with unsupported content\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "The final commit hashes will be written to stdout as they are pushed.\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "If there are no commits in the specified range (or -commit is specified without\n")
	fmt.Fprintf(flag.CommandLine.Output(), "anything in the staging area or -allow-empty), the command does nothing (and\n")
	fmt.Fprintf(flag.CommandLine.Output(), "prints a message if not -q), then exits with status 0.\n")
}

func main() {
	flag.Parse()

	if flag.NArg() != 3 {
		usage()
		os.Exit(2)
	}

	if *AllowEmpty && !*Commit {
		usage()
		os.Exit(2)
	}

	if *Insecure {
		http.DefaultTransport.(*http.Transport).TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true,
		}
	}

	if *Chdir != "" {
		if err := os.Chdir(*Chdir); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
	}

	if err := run(flag.Arg(0), flag.Arg(1), flag.Arg(2)); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		if _, ok := errors.AsType[*notPushableError](err); ok {
			os.Exit(30)
		}
		os.Exit(1)
	}
}

type notPushableError struct {
	Commit OID
	Reason error
}

func (err *notPushableError) Error() string {
	var what string
	if err.Commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(err.Commit)
	}
	return fmt.Sprintf("%s cannot be pushed via the API: %v", what, err.Reason)
}

func (err *notPushableError) Unwrap() error {
	return err.Reason
}

func notPushableErrf(commit OID, format string, a ...any) error {
	return &notPushableError{
		Commit: commit,
		Reason: fmt.Errorf(format, a...),
	}
}

func run(repo, branch, specOrMessage string) error {
	if p, err := exec.LookPath(cmp.Or(*Git, "git")); err != nil {
		return fmt.Errorf("resolve git binary: %w", err)
	} else {
		*Git = p
	}

	ver, err := gitVersion()
	if err != nil {
		return fmt.Errorf("get git version: %w", err)
	}
	verbose("git version %s", ver)

	if major, minor, _, ok := parseVersion(ver); !ok {
		// it might be a commit if built from source
		fmt.Fprintf(os.Stderr, "warning: failed to parse git version %q, will continue anyways\n", ver)
	} else if !(major > MinGitMajor || (major == MinGitMajor && minor >= MinGitMinor)) {
		return fmt.Errorf("git %q is too old (we need at least %d.%d)", ver, MinGitMajor, MinGitMinor)
	}

	if *Commit {
		return runCommit(repo, branch, specOrMessage)
	}
	return runCommits(repo, branch, specOrMessage)
}

func runCommit(repo, branch, message string) error {
	parent, err := gitHead()
	if err != nil {
		return fmt.Errorf("get head commit: %w", err)
	}

	files, err := gitStagedDiff(parent)
	if err != nil {
		return fmt.Errorf("diff staging area against head %s: %w", parent, err)
	}
	for _, file := range files {
		verbose("diff %s %q", file.Status, file.Path)
	}

	if !*AllowEmpty && len(files) == 0 {
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "nothing to commit in the staging area\n")
		}
		return nil
	}

	subject, body := cutCommitMessage(message)
	verbose("subject %q", subject)
	verbose("body %q", body)

	input := gqlCreateCommitOnBranchInput{
		Branch: gqlCommittableBranch{
			RepositoryNameWithOwner: repo,
			BranchName:              branch,
		},
		Message: gqlCommitMessage{
			Headline: subject,
			Body:     body,
		},
		ExpectedHeadOid: parent,
	}

	// note: files are transformed (e.g., for core.autocrlf) when adding them to
	// the index, so that isn't something we have to worry about here

	input.FileChanges, err = changes("", files)
	if err != nil {
		return err
	}

	inputJSON, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("marshal json: %w", err)
	}

	if *DryRun {
		os.Stdout.Write(append(inputJSON, '\n'))
		return nil
	}

	verbose("creating commit")

	if !*Quiet {
		fmt.Fprintf(os.Stderr, "pushing new commit from staging area (size=%d additions=%d deletions=%d) over %s:%s@%s\n", len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)
	}
	newCommit, err := ghCreateCommitOnBranch(input)
	if err != nil {
		return fmt.Errorf("failed to create new commit from staging area: %w", err)
	}
	if !*Quiet {
		fmt.Fprintf(os.Stderr, "-> %s\n", newCommit)
	}
	fmt.Println(newCommit)

	return nil
}

func runCommits(repo, branch, spec string) error {
	commits, err := gitCommits(spec)
	if err != nil {
		return fmt.Errorf("list commits for %q: %w", spec, err)
	}
	verbose("resolved %q to commits %s", spec, commits)

	if len(commits) == 0 {
		// e.g., for HEAD..HEAD
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "nothing to push\n")
		}
		return nil
	}

	slices.Reverse(commits)

	var prevNewCommit OID
	for i, commit := range commits {
		verbose("[%d/%d] processing commit %s", i+1, len(commits), commit)

		parents, err := gitCommitParents(commit)
		if err != nil {
			return fmt.Errorf("list parents of commit %s: %w", commit, err)
		}
		verbose("commit %s has parents %s", commit, parents)

		if len(parents) == 0 {
			return notPushableErrf(commit, "commit has no parents (cannot create new branch)")
		}
		if len(parents) != 1 {
			return notPushableErrf(commit, "commit has multiple parents (cannot push merge commits)")
		}
		parent := parents[0]

		message, err := gitCommitMessage(commit)
		if err != nil {
			return fmt.Errorf("get subject of commit %s: %w", commit, err)
		}

		subject, body := cutCommitMessage(message)
		verbose("subject %q", subject)
		verbose("body %q", body)

		input := gqlCreateCommitOnBranchInput{
			Branch: gqlCommittableBranch{
				RepositoryNameWithOwner: repo,
				BranchName:              branch,
			},
			Message: gqlCommitMessage{
				Headline: subject,
				Body:     body,
			},
			ExpectedHeadOid: cmp.Or(prevNewCommit, parent),
		}

		files, err := gitCommitDiff(parent, commit)
		if err != nil {
			return fmt.Errorf("compute diff of commit %s: %w", commit, err)
		}
		for _, file := range files {
			verbose("diff %s %q", file.Status, file.Path)
		}

		input.FileChanges, err = changes(commit, files)
		if err != nil {
			return err
		}

		inputJSON, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("marshal json: %w", err)
		}

		if *DryRun {
			os.Stdout.Write(append(inputJSON, '\n'))
			prevNewCommit = OID(strings.Repeat("x", len(commit)))
			continue
		}

		verbose("creating commit")

		if !*Quiet {
			fmt.Fprintf(os.Stderr, "[%d/%d] pushing %s (size=%d additions=%d deletions=%d) over %s:%s@%s\n", i+1, len(commits), commit, len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)
		}
		newCommit, err := ghCreateCommitOnBranch(input)
		if err != nil {
			return fmt.Errorf("failed to create commit for local commit %s: %w", commit, err)
		}
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "[%d/%d] -> %s\n", i+1, len(commits), newCommit)
		}
		fmt.Println(newCommit)

		prevNewCommit = newCommit
	}
	return nil
}

func changes(commit OID, diff []gitDiffFile) (changes gqlFileChanges, err error) {
	changes = gqlFileChanges{
		Additions: []gqlFileAddition{},
		Deletions: []gqlFileDeletion{},
	}
	var what string
	if commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(commit)
	}
	for _, file := range diff {
		switch file.Status {
		case gitCommitDiffAdded, gitCommitDiffModified, gitCommitDiffTypeChanged:
			objs, err := gitListTreeObjects(commit, file.Path)
			if err != nil {
				return changes, fmt.Errorf("get %s tree object %q: %w", what, file.Path, err)
			}
			if len(objs) != 1 {
				// diff-tree doesn't return trees, so it should only ever have one
				return changes, fmt.Errorf("get %s tree object %q: expected exactly one object", what, file.Path)
			}
			obj := objs[0]

			switch obj.Type {
			case "blob": // file
				// okay
			case "commit": // submodule
				return changes, notPushableErrf(commit, "contains an added/modified submodule %q", file.Path)
			case "tree":
				return changes, fmt.Errorf("wtf: why is %q a tree", file.Path)
			default:
				return changes, notPushableErrf(commit, "contains an added/modified object %q with unknown type %s", file.Path, obj.Type)
			}
			switch obj.Mode {
			case 100644: // regular file
				// okay
			case 100755: // executable file
				return changes, notPushableErrf(commit, "contains an executable file %q", file.Path)
			case 120000: // symbolic link
				return changes, notPushableErrf(commit, "contains a symbolic link %q", file.Path)
			default: // should never happen since git doesn't store other modes
				return changes, notPushableErrf(commit, "contains a non-regular file %q with mode %d", file.Path, obj.Mode)
			}

			buf, err := gitCatFile(obj.OID)
			if err != nil {
				return changes, fmt.Errorf("get %s file %q contents: %w", what, file.Path, err)
			}
			changes.Additions = append(changes.Additions, gqlFileAddition{
				Path:     file.Path,
				Contents: gqlBase64String(buf),
			})

		case gitCommitDiffDeleted:
			changes.Deletions = append(changes.Deletions, gqlFileDeletion{
				Path: file.Path,
			})

		default:
			return changes, notPushableErrf(commit, "unsupported diff status %s (%s)", file.Status, file)
		}
	}
	return changes, nil
}

func verbose(format string, a ...any) {
	if *Verbose {
		fmt.Fprintf(os.Stderr, format+"\n", a...)
	}
}

func debugcmd(cmd string, args ...string) {
	if *Debug {
		fmt.Fprintf(os.Stderr, "# %s%s\n", cmd, fmtargs(args...))
	}
}

func fmtargs(args ...string) string {
	var s []byte
	for _, a := range args {
		s = append(s, ' ')
		s = appendMaybeQuoteToASCII(s, a)
	}
	return string(s)
}

func appendMaybeQuoteToASCII(dst []byte, s string) []byte {
	i := len(dst)
	dst = strconv.AppendQuoteToASCII(dst, s)
	if len(dst)-i > 2 && string(dst[i+1:len(dst)-1]) == s {
		dst = append(dst[:i], s...)
	}
	return dst
}
