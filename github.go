package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const DefaultGitHubGraphqlURL = "https://api.github.com/graphql"

type gqlCreateCommitOnBranchInput struct {
	Branch          gqlCommittableBranch `json:"branch"`
	ExpectedHeadOid gqlGitObjectID       `json:"expectedHeadOid"`
	Message         gqlCommitMessage     `json:"message"`
	FileChanges     gqlFileChanges       `json:"fileChanges"`
}

type gqlCommittableBranch struct {
	RepositoryNameWithOwner string `json:"repositoryNameWithOwner"`
	BranchName              string `json:"branchName"`
}

type gqlGitObjectID = OID

type gqlCommitMessage struct {
	Headline string `json:"headline"`
	Body     string `json:"body"`
}

type gqlFileChanges struct {
	Additions []gqlFileAddition `json:"additions"`
	Deletions []gqlFileDeletion `json:"deletions"`
}

type gqlFileAddition struct {
	Contents gqlBase64String `json:"contents"`
	Path     string          `json:"path"`
}

type gqlFileDeletion struct {
	Path string `json:"path"`
}

type gqlBase64String []byte

var _ json.Marshaler = (gqlBase64String)(nil)

func (b gqlBase64String) MarshalJSON() ([]byte, error) {
	dst := make([]byte, 0, base64.StdEncoding.EncodedLen(len(b))+2)
	dst = append(dst, '"')
	dst = base64.StdEncoding.AppendEncode(dst, b)
	dst = append(dst, '"')
	return dst, nil
}

func ghCreateCommitOnBranch(input gqlCreateCommitOnBranchInput) (OID, error) {
	query := `
		mutation($input: CreateCommitOnBranchInput!) {
			createCommitOnBranch(input: $input) {
				commit {
					oid
				}
			}
		}
	`
	type result struct {
		CreateCommitOnBranch struct {
			Commit struct {
				OID OID `json:"oid"`
			} `json:"commit"`
		} `json:"createCommitOnBranch"`
	}
	resp, err := ghGraphql[result](query, map[string]any{"input": input})
	if err != nil {
		// best-effort attempt to have better errors for certain cases (as of 2026-04-04)
		switch {
		case strings.Contains(err.Error(), "No commit exists with specified expectedHeadOid"):
			return "", fmt.Errorf("remote branch head is behind local parent commit (error: %w)", err)
		case strings.Contains(err.Error(), "Expected branch to point to"):
			return "", fmt.Errorf("local parent commit is behind remote branch head (error: %w)", err)
		}
		return "", err
	}
	if !resp.CreateCommitOnBranch.Commit.OID.Valid() {
		return "", fmt.Errorf("github created the commit but returned an empty/invalid oid %q", resp.CreateCommitOnBranch.Commit.OID)
	}
	return resp.CreateCommitOnBranch.Commit.OID, nil
}

var ghMutationRateLimit *time.Ticker

func ghGraphql[T any](query string, variables map[string]any) (*T, error) {
	var reqObj struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	reqObj.Query = query
	reqObj.Variables = variables

	reqObjJSON, err := json.Marshal(reqObj)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	verbose("request body size %d", len(reqObjJSON))

	req, err := http.NewRequest(http.MethodPost, GitHubGraphqlURL, bytes.NewReader(reqObjJSON))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", strconv.Itoa(len(reqObjJSON)))
	req.Header.Set("Accept", "application/json")

	if GitHubToken == "" {
		return nil, fmt.Errorf("no github token specified")
	}
	req.Header.Set("Authorization", "Bearer "+GitHubToken)

	var buf []byte
	for try := 1; ; try++ {
		if ghMutationRateLimit == nil {
			ghMutationRateLimit = time.NewTicker(time.Second) // https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#staying-under-the-rate-limit
		} else {
			select {
			case <-ghMutationRateLimit.C:
			default:
				verbose("delaying request to stay within rate limit")
				<-ghMutationRateLimit.C
			}
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		buf, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("read response: %w", err)
		}

		verbose("response status %d", resp.StatusCode)
		for k, vs := range resp.Header {
			for _, v := range vs {
				verbose("response header %s = %q", k, v)
			}
		}
		verbose("response body %q", buf)

		// https://github.com/octokit/plugin-retry.js/blob/v8.1.0/src/index.ts
		if resp.StatusCode >= 400 {
			switch resp.StatusCode {
			case 400, 401, 403, 404, 410, 422, 451:
				return nil, fmt.Errorf("non-retryable response status %d (try: %d, body: %q)", try, resp.StatusCode, buf)
			}
			if try > 3 {
				return nil, fmt.Errorf("response status %d, no retries left (try: %d, body: %q)", try, resp.StatusCode, buf)
			}
			retryAfter := time.Duration(float64(time.Second) * math.Pow(float64(try), 2))
			fmt.Fprintf(os.Stderr, "warning: request failed, will retry after %s (response status %d, body %q)", retryAfter, resp.StatusCode, buf)
			<-time.After(retryAfter)
			continue
		}

		if mt, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type")); mt != "application/json" {
			if resp.StatusCode != 200 {
				return nil, fmt.Errorf("response status %d (body: %q)", resp.StatusCode, buf)
			}
			return nil, fmt.Errorf("incorrect response type %q", mt)
		}
		break
	}

	var respObj struct {
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
		Data T `json:"data"`
	}
	if err := json.Unmarshal(buf, &respObj); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	var errs []error
	for _, e := range respObj.Errors {
		errs = append(errs, fmt.Errorf("%s: %s", e.Type, e.Message))
	}
	if err := errors.Join(errs...); err != nil {
		return nil, fmt.Errorf("github failed to create commit: %w", err)
	}
	return &respObj.Data, nil
}
