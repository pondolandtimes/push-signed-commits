package main

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultGitHubAPI     GitHubAPI     = "https://api.github.com"
	DefaultGitHubGraphQL GitHubGraphQL = "https://api.github.com/graphql"
)

type GitHubToken string

type GitHubAPI string

func (gh GitHubAPI) AppJWT(appID int64, key *rsa.PrivateKey) (GitHubToken, error) {
	var jwt []byte
	jwt = base64.RawURLEncoding.AppendEncode(jwt, []byte(`{"alg":"RS256","typ":"JWT"}`))
	jwt = append(jwt, '.')
	jwt = base64.RawURLEncoding.AppendEncode(jwt, []byte(`{`+
		`"iat":`+strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)+
		`,"exp":`+strconv.FormatInt(time.Now().Add(time.Minute*1).Unix(), 10)+
		`,"iss":"`+strconv.FormatInt(appID, 10)+`"}`))

	sha := sha256.Sum256(jwt)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sha[:])
	if err != nil {
		return "", err
	}

	jwt = append(jwt, '.')
	jwt = base64.RawURLEncoding.AppendEncode(jwt, sig)
	return GitHubToken(jwt), nil
}

func (gh GitHubAPI) GetRepoInstallation(jwt GitHubToken, repo string) (int64, error) {
	verbose("getting app installation id for repo %q", repo)
	resp, buf, err := gh.request(jwt, http.MethodGet, "repos/"+repo+"/installation", nil)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("response status %d (body: %q)", resp.StatusCode, buf)
	}

	var obj struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(buf, &obj); err != nil {
		return 0, fmt.Errorf("parse response: %w", err)
	}
	if obj.ID == 0 {
		return 0, fmt.Errorf("parse response: missing installation id")
	}
	verbose("got installation id %d", obj.ID)

	return obj.ID, nil
}

func (gh GitHubAPI) CreateInstallationToken(jwt GitHubToken, repo string, installID int64) (GitHubToken, error) {
	if _, r, ok := strings.Cut(repo, "/"); ok {
		repo = r
	}

	verbose("getting app installation token for repo %q", repo)
	resp, buf, err := gh.request(jwt, http.MethodPost, "app/installations/"+strconv.FormatInt(installID, 10)+"/access_tokens", map[string]any{
		"repositories": []string{repo},
		"permissions": map[string]string{
			"contents": "write",
		},
	})
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("response status %d (body: %q)", resp.StatusCode, buf)
	}

	var obj struct {
		Token       string `json:"token"`
		Permissions struct {
			Contents string `json:"contents"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(buf, &obj); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}
	if obj.Token == "" {
		return "", fmt.Errorf("parse response: missing token")
	}
	if obj.Permissions.Contents != "write" {
		return "", fmt.Errorf("installation does not have contents:write access")
	}
	verbose("got installation token")

	return GitHubToken(obj.Token), nil
}

func (gh GitHubAPI) RevokeInstallationToken(token GitHubToken) error {
	verbose("revoking app installation token")
	resp, buf, err := gh.request(token, http.MethodDelete, "installation/token", nil)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("response status %d (body: %q)", resp.StatusCode, buf)
	}
	verbose("app installation token revoked")

	return nil
}

func (gh GitHubAPI) request(token GitHubToken, method, path string, body any) (*http.Response, []byte, error) {
	u, err := url.Parse(string(gh))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	u = u.JoinPath("/", path) // not ResolveReference since we just want to append the elements

	var (
		r        io.Reader
		bodyJSON []byte
	)
	if body != nil {
		bodyJSON, err = json.Marshal(body)
		if err != nil {
			return nil, nil, fmt.Errorf("marshal request: %w", err)
		}
		r = bytes.NewReader(bodyJSON)
	}
	req, err := http.NewRequest(method, u.String(), r)
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Length", strconv.Itoa(len(bodyJSON)))
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2026-03-10")

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+string(token))
	}
	if UserAgent != "" {
		req.Header.Set("User-Agent", UserAgent)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		err = fmt.Errorf("read response: %w", err)
	}
	return resp, buf, err
}

type CreateCommitOnBranchInput struct {
	Branch          CommittableBranch `json:"branch"`
	ExpectedHeadOid GitObjectID       `json:"expectedHeadOid"`
	Message         CommitMessage     `json:"message"`
	FileChanges     FileChanges       `json:"fileChanges"`
}

type CommittableBranch struct {
	RepositoryNameWithOwner string `json:"repositoryNameWithOwner"`
	BranchName              string `json:"branchName"`
}

type GitObjectID = OID

type CommitMessage struct {
	Headline string `json:"headline"`
	Body     string `json:"body"`
}

type FileChanges struct {
	Additions []FileAddition `json:"additions"`
	Deletions []FileDeletion `json:"deletions"`
}

type FileAddition struct {
	Contents Base64String `json:"contents"`
	Path     string       `json:"path"`
}

type FileDeletion struct {
	Path string `json:"path"`
}

type Base64String []byte

var _ json.Marshaler = (Base64String)(nil)
var _ json.Unmarshaler = (*Base64String)(nil)

func (b Base64String) MarshalJSON() ([]byte, error) {
	dst := make([]byte, 0, base64.StdEncoding.EncodedLen(len(b))+2)
	dst = append(dst, '"')
	dst = base64.StdEncoding.AppendEncode(dst, b)
	dst = append(dst, '"')
	return dst, nil
}

func (b *Base64String) UnmarshalJSON(buf []byte) error {
	var s string
	if err := json.Unmarshal(buf, &s); err != nil {
		return err
	}
	if x, err := base64.StdEncoding.DecodeString(s); err != nil {
		return err
	} else {
		*b = Base64String(x)
	}
	return nil
}

type GitHubGraphQL string

func (gh GitHubGraphQL) CreateCommitOnBranch(token GitHubToken, input CreateCommitOnBranchInput) (OID, error) {
	query := `
		mutation($input: CreateCommitOnBranchInput!) {
			createCommitOnBranch(input: $input) {
				commit {
					oid
				}
			}
		}
	`
	data, err := gh.query(token, query, map[string]any{"input": input})
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
	var obj struct {
		CreateCommitOnBranch struct {
			Commit struct {
				OID OID `json:"oid"`
			} `json:"commit"`
		} `json:"createCommitOnBranch"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}
	if !obj.CreateCommitOnBranch.Commit.OID.Valid() {
		return "", fmt.Errorf("github created the commit but returned an empty/invalid oid %q", obj.CreateCommitOnBranch.Commit.OID)
	}
	return obj.CreateCommitOnBranch.Commit.OID, nil
}

var ghMutationRateLimit *time.Ticker

func (gh GitHubGraphQL) query(token GitHubToken, query string, variables map[string]any) (json.RawMessage, error) {
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

	req, err := http.NewRequest(http.MethodPost, string(gh), bytes.NewReader(reqObjJSON))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", strconv.Itoa(len(reqObjJSON)))
	req.Header.Set("Accept", "application/json")

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+string(token))
	}
	if UserAgent != "" {
		req.Header.Set("User-Agent", UserAgent)
	}

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
			return nil, fmt.Errorf("do request: %w", err)
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
			warning("request failed, will retry after %s (response status %d, body %q)", retryAfter, resp.StatusCode, buf)
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
		Data json.RawMessage `json:"data"`
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
	return respObj.Data, nil
}
