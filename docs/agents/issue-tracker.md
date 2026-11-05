# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `merayupi/hivecast`. Use the `gh` CLI from this clone; it infers the repo from the Git remote. Outside the clone, pass `--repo merayupi/hivecast`.

## Conventions

- Create: `gh issue create --title "..." --body "..."`. For multi-line bodies, use `--body-file <path>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`. Add label and state filters as needed.
- Comment: `gh issue comment <number> --body "..."`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.
- Link a child issue: `gh api --method POST repos/merayupi/hivecast/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. Obtain the database ID with `gh api repos/merayupi/hivecast/issues/<child> --jq .id`. If sub-issues are unavailable, add the child to a task list in the parent body and put `Part of #<parent>` at the top of the child body.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When set to `yes`, use the same triage labels and states for external PRs:

- Read: `gh pr view <number> --comments` and `gh pr diff <number>`.
- List external PRs: `gh api --paginate 'repos/merayupi/hivecast/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- Comment, label, or close: `gh pr comment`, `gh pr edit --add-label` / `--remove-label`, `gh pr close`.

Issues and PRs share a number space. For an ambiguous reference, resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill operations

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the issue using the command above.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue; its children are tickets.

- Map: create an issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- Child ticket: link it to the map as a sub-issue using the convention above. Label it `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- Blocking: use native issue dependencies: `gh api --method POST repos/merayupi/hivecast/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Use the numeric database ID, not the issue number or node ID. If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Frontier: list the map's open children in map order. Exclude assigned tickets and those with open blockers (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line). Select the first remaining ticket.
- Claim: `gh issue edit <number> --add-assignee @me`, as the session's first write.
- Resolve: comment with the answer, close the ticket, then append a gist and link to the map's Decisions-so-far.
