package main

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"slices"
	"strings"
)

type NotPushableError struct {
	Commit OID
	Reason error
}

func (err *NotPushableError) Error() string {
	var what string
	if err.Commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(err.Commit)
	}
	return fmt.Sprintf("%s cannot be pushed via the API: %v", what, err.Reason)
}

func (err *NotPushableError) Unwrap() error {
	return err.Reason
}

func notPushableErrf(commit OID, format string, a ...any) error {
	return &NotPushableError{
		Commit: commit,
		Reason: fmt.Errorf(format, a...),
	}
}

type Options struct {
	Git    Git
	DryRun bool

	GitHubAPI     GitHubAPI
	GitHubGraphQL GitHubGraphQL

	Token  GitHubToken
	App    int64
	AppKey string

	Revision         string
	Commit           bool
	CommitAllowEmpty bool
	CommitMessage    string

	OnDryRunCommit         func(input CreateCommitOnBranchInput, inputJSON []byte)
	OnPushedNewCommit      func(newCommit OID)
	OnPushedExistingCommit func(localCommit, newCommit OID)
}

func Run(repo, branch string, opt Options) error {
	if err := opt.Git.LookPath(); err != nil {
		return fmt.Errorf("resolve git binary: %w", err)
	}

	if version, checked, err := opt.Git.CheckVersion(); err != nil {
		return fmt.Errorf("check git version: %w", err)
	} else {
		if !checked {
			warning("failed to parse git version %q, will continue anyways", version)
		}
		verbose("git version %s", version)
	}

	if !opt.DryRun {
		if opt.App != 0 {
			if opt.AppKey == "" {
				return fmt.Errorf("no app private key specified")
			}

			status("generating app token for app %d", opt.App)
			keyStr := strings.ReplaceAll(opt.AppKey, `\n`, "\n")
			if buf, err := base64.StdEncoding.DecodeString(keyStr); err == nil {
				keyStr = string(buf)
			}
			keyBlock, _ := pem.Decode([]byte(keyStr))
			if keyBlock == nil {
				return fmt.Errorf("failed to decode app private key pem")
			}
			if keyBlock.Type != "RSA PRIVATE KEY" {
				return fmt.Errorf("app private key is not rsa, got %q", keyBlock.Type)
			}
			key, err := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
			if err != nil {
				return fmt.Errorf("parse app private rsa key")
			}
			jwt, err := opt.GitHubAPI.AppJWT(opt.App, key)
			if err != nil {
				return fmt.Errorf("generate app token for app %d: %w", opt.App, err)
			}

			status("getting app installation for repo %q", repo)
			installID, err := opt.GitHubAPI.GetRepoInstallation(jwt, repo)
			if err != nil {
				return fmt.Errorf("get app installation for repo %q: %w", repo, err)
			}

			status("creating app installation token for repo %q installation %d", repo, installID)
			token, err := opt.GitHubAPI.CreateInstallationToken(jwt, repo, installID)
			if err != nil {
				return fmt.Errorf("create app installation token for repo %q installation %d: %w", repo, installID, err)
			}
			defer func() {
				status("revoking app installation token")
				if err := opt.GitHubAPI.RevokeInstallationToken(token); err != nil {
					warning("failed to revoke app installation token: %v")
				}
			}()

			opt.Token = token
		} else if opt.Token == "" {
			return fmt.Errorf("no github token specified")
		}
	}

	if opt.Commit {
		parent, err := opt.Git.Head()
		if err != nil {
			return fmt.Errorf("get head commit: %w", err)
		}

		files, err := opt.Git.StagedDiff(parent)
		if err != nil {
			return fmt.Errorf("diff staging area against head %s: %w", parent, err)
		}
		for _, file := range files {
			verbose("diff %s %q", file.Status, file.Path)
		}

		if !opt.CommitAllowEmpty && len(files) == 0 {
			status("nothing to commit in the staging area")
			return nil
		}

		subject, body := CutCommitMessage(opt.CommitMessage)
		verbose("subject %q", subject)
		verbose("body %q", body)

		input := CreateCommitOnBranchInput{
			Branch: CommittableBranch{
				RepositoryNameWithOwner: repo,
				BranchName:              branch,
			},
			Message: CommitMessage{
				Headline: subject,
				Body:     body,
			},
			ExpectedHeadOid: parent,
		}

		// note: files are transformed (e.g., for core.autocrlf) when adding them to
		// the index, so that isn't something we have to worry about here

		input.FileChanges, err = Changes(opt.Git, "", files)
		if err != nil {
			return err
		}

		inputJSON, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("marshal json: %w", err)
		}

		if opt.DryRun {
			if opt.OnDryRunCommit != nil {
				opt.OnDryRunCommit(input, inputJSON)
			}
			return nil
		}

		verbose("creating commit")

		status("pushing new commit from staging area (size=%d additions=%d deletions=%d) over %s:%s@%s", len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)

		newCommit, err := opt.GitHubGraphQL.CreateCommitOnBranch(opt.Token, input)
		if err != nil {
			return fmt.Errorf("failed to create new commit from staging area: %w", err)
		}
		status("-> %s", newCommit)

		if opt.OnPushedNewCommit != nil {
			opt.OnPushedNewCommit(newCommit)
		}
	} else {
		commits, err := opt.Git.Commits(opt.Revision)
		if err != nil {
			return fmt.Errorf("list commits for %q: %w", opt.Revision, err)
		}
		verbose("resolved %q to commits %s", opt.Revision, commits)

		if len(commits) == 0 {
			// e.g., for HEAD..HEAD
			status("nothing to push")
			return nil
		}

		slices.Reverse(commits)

		var prevNewCommit OID
		for i, commit := range commits {
			verbose("[%d/%d] processing commit %s", i+1, len(commits), commit)

			parents, err := opt.Git.CommitParents(commit)
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

			message, err := opt.Git.CommitMessage(commit)
			if err != nil {
				return fmt.Errorf("get subject of commit %s: %w", commit, err)
			}

			subject, body := CutCommitMessage(message)
			verbose("subject %q", subject)
			verbose("body %q", body)

			input := CreateCommitOnBranchInput{
				Branch: CommittableBranch{
					RepositoryNameWithOwner: repo,
					BranchName:              branch,
				},
				Message: CommitMessage{
					Headline: subject,
					Body:     body,
				},
				ExpectedHeadOid: parent,
			}
			if prevNewCommit != "" {
				input.ExpectedHeadOid = prevNewCommit
			}

			files, err := opt.Git.CommitDiff(parent, commit)
			if err != nil {
				return fmt.Errorf("compute diff of commit %s: %w", commit, err)
			}
			for _, file := range files {
				verbose("diff %s %q", file.Status, file.Path)
			}

			input.FileChanges, err = Changes(opt.Git, commit, files)
			if err != nil {
				return err
			}

			inputJSON, err := json.Marshal(input)
			if err != nil {
				return fmt.Errorf("marshal json: %w", err)
			}

			if opt.DryRun {
				if opt.OnDryRunCommit != nil {
					opt.OnDryRunCommit(input, inputJSON)
				}
				prevNewCommit = OID(strings.Repeat("x", len(commit)))
				continue
			}

			verbose("creating commit")

			status("[%d/%d] pushing %s (size=%d additions=%d deletions=%d) over %s:%s@%s", i+1, len(commits), commit, len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)
			newCommit, err := opt.GitHubGraphQL.CreateCommitOnBranch(opt.Token, input)
			if err != nil {
				return fmt.Errorf("failed to create commit for local commit %s: %w", commit, err)
			}
			status("[%d/%d] -> %s", i+1, len(commits), newCommit)

			if opt.OnPushedExistingCommit != nil {
				opt.OnPushedExistingCommit(commit, newCommit)
			}
			prevNewCommit = newCommit
		}
	}
	return nil
}

func Changes(git Git, commit OID, diff []GitDiffFile) (changes FileChanges, err error) {
	changes = FileChanges{
		Additions: []FileAddition{},
		Deletions: []FileDeletion{},
	}
	var what string
	if commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(commit)
	}
	for _, file := range diff {
		switch file.Status {
		case GitDiffStatusAdded, GitDiffStatusModified, GitDiffStatusTypeChanged:
			objs, err := git.ListTreeObjects(commit, file.Path)
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

			buf, err := git.CatFile(obj.OID)
			if err != nil {
				return changes, fmt.Errorf("get %s file %q contents: %w", what, file.Path, err)
			}
			changes.Additions = append(changes.Additions, FileAddition{
				Path:     file.Path,
				Contents: Base64String(buf),
			})

		case GitDiffStatusDeleted:
			changes.Deletions = append(changes.Deletions, FileDeletion{
				Path: file.Path,
			})

		default:
			return changes, notPushableErrf(commit, "unsupported diff status %s (%s)", file.Status, file)
		}
	}
	return changes, nil
}
