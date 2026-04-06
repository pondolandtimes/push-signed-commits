package main

import (
	"cmp"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
)

var (
	warning  = func(format string, a ...any) {}
	status   = func(format string, a ...any) {}
	verbose  = func(format string, a ...any) {}
	debugcmd = func(cmd string, args ...string) {}
)

var UserAgent = func() string {
	var ua strings.Builder

	ua.WriteString("push-signed-commits/")
	if info, ok := debug.ReadBuildInfo(); ok && strings.HasPrefix(info.Main.Version, "v") {
		ua.WriteString(info.Main.Version[1:])
	} else {
		ua.WriteString("devel")
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Path != "" {
		ua.WriteString(" (")
		ua.WriteString(runtime.GOOS)
		ua.WriteString("/")
		ua.WriteString(runtime.GOARCH)
		ua.WriteString("; ")
		ua.WriteString(info.Main.Path)
		if info.Main.Sum != "" {
			ua.WriteString(" ")
			ua.WriteString(info.Main.Sum)
		}
		ua.WriteString(")")
	}

	if ci, _ := strconv.ParseBool(os.Getenv("CI")); ci && os.Getenv("GITHUB_ACTION") != "" {
		ua.WriteString(" github-actions (")
		ua.WriteString(os.Getenv("GITHUB_REPOSITORY"))
		if v := os.Getenv("GITHUB_RUN_ID"); v != "" {
			ua.WriteString("; run-id=")
			ua.WriteString(v)
		}
		if v := os.Getenv("GITHUB_ACTOR_ID"); v != "" {
			ua.WriteString("; actor-id=")
			ua.WriteString(v)
		}
		if v := os.Getenv("RUNNER_ENVIRONMENT"); v != "" {
			ua.WriteString("; runner-environment=")
			ua.WriteString(v)
		}
		ua.WriteString(")")
	}

	return ua.String()
}()

func main() {
	const (
		envGitHubApiURL     = "GITHUB_API_URL"     // set by GitHub Actions
		envGitHubGraphqlURL = "GITHUB_GRAPHQL_URL" // set by GitHub Actions
		envGitHubToken      = "GITHUB_TOKEN"       // set by GitHub Actions, also the conventional env var name
	)

	var (
		gh    = cmp.Or(GitHubAPI(os.Getenv(envGitHubApiURL)), DefaultGitHubAPI)
		gql   = cmp.Or(GitHubGraphQL(os.Getenv(envGitHubGraphqlURL)), DefaultGitHubGraphQL)
		token = GitHubToken(os.Getenv(envGitHubToken))
	)

	var (
		chdir = flag.String("C", "", "change to a different directory before running the command")
		git   = flag.String("g", "", "use a different git binary (minimum version "+strconv.Itoa(MinGitMajor)+"."+strconv.Itoa(MinGitMinor)+")")

		dryRun    = flag.Bool("n", false, "do not push commits, just dump the mutations to stdout, one line per commit")
		quiet     = flag.Bool("q", false, "do not print status messages to stderr")
		isVerbose = flag.Bool("v", false, "print verbose information to stderr")
		isDebug   = flag.Bool("x", false, "print the git commands to stderr")

		app    = flag.Int64("app", 0, "use a github app installation token for the specified app id (the installation id will be looked up for the target repo)")
		appKey = flag.String("app.key", "APP_PRIVATE_KEY", "name of an environment variable containing the private key (value can be base64-encoded or have \\n escaped newlines)")

		commit           = flag.Bool("commit", false, "commit the staged changes")
		commitAllowEmpty = flag.Bool("commit.allow-empty", false, "allow an empty commit to be created (only valid with -commit)")
	)

	tlsConfig := http.DefaultTransport.(*http.Transport).TLSClientConfig
	if tlsConfig == nil {
		tlsConfig = new(tls.Config)
	}

	flag.BoolVar(&tlsConfig.InsecureSkipVerify, "k", false, "do not validate ssl certificates")
	flag.StringVar(&UserAgent, "user-agent", UserAgent, "override the user agent for api requests")

	flag.CommandLine.Usage = func() {
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
		fmt.Fprintf(flag.CommandLine.Output(), "  %-20s  github rest api endpoint (default %q)\n", envGitHubApiURL, string(DefaultGitHubAPI))
		fmt.Fprintf(flag.CommandLine.Output(), "  %-20s  github graphql endpoint (default %q)\n", envGitHubGraphqlURL, string(DefaultGitHubGraphQL))
		fmt.Fprintf(flag.CommandLine.Output(), "  %-20s  github token (required if not -n or -app)\n", envGitHubToken)
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
	flag.Parse()

	warning = func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, "warning: "+format+"\n", a...)
	}

	status = func(format string, a ...any) {
		if !*quiet {
			fmt.Fprintf(os.Stderr, format+"\n", a...)
		}
	}

	verbose = func(format string, a ...any) {
		if *isVerbose {
			fmt.Fprintf(os.Stderr, format+"\n", a...)
		}
	}

	debugcmd = func(cmd string, args ...string) {
		if *isDebug {
			fmt.Fprintf(os.Stderr, "# %s%s\n", cmd, fmtargs(args...))
		}
	}

	if flag.NArg() != 3 {
		flag.CommandLine.Usage()
		os.Exit(2)
	}

	if *commitAllowEmpty && !*commit {
		flag.CommandLine.Usage()
		os.Exit(2)
	}

	if !*dryRun && *app != 0 && (*appKey == "" || os.Getenv(*appKey) == "") {
		fmt.Fprintf(os.Stderr, "error: app key must point to a non-empty environment variable\n")
		os.Exit(2)
	}

	if *chdir != "" {
		if err := os.Chdir(*chdir); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
	}

	if err := Run(flag.Arg(0), flag.Arg(1), Options{
		Git:    Git(*git),
		DryRun: *dryRun,

		GitHubAPI:     gh,
		GitHubGraphQL: gql,

		Token:  token,
		App:    *app,
		AppKey: os.Getenv(*appKey),

		Revision:         flag.Arg(2),
		Commit:           *commit,
		CommitAllowEmpty: *commitAllowEmpty,
		CommitMessage:    flag.Arg(2),

		OnDryRunCommit: func(input CreateCommitOnBranchInput, inputJSON []byte) {
			os.Stdout.Write(append(inputJSON, '\n'))
		},
		OnPushedNewCommit: func(newCommit OID) {
			fmt.Println(newCommit)
		},
		OnPushedExistingCommit: func(localCommit, newCommit OID) {
			fmt.Println(newCommit)
		},
	}); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		if errors.As(err, new(*NotPushableError)) {
			os.Exit(30)
		}
		os.Exit(1)
	}
}
