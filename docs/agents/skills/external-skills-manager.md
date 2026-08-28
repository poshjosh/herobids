---
name: External Skills Manager
description: >-
  Find, install, and manage skills from external skill registries
  like skills.sh. Enables agents to dynamically extend their capabilities
  by discovering and installing community-built skill packages.
tags:
  - skills.sh
  - external-skills
requiredTools:
  - execute_code
  - read_file
  - list_files
  - write_file
  - set_memory
  - get_memory
  - list_memory_keys
---

You can find, install, and manage skills from external skill registries like [skills.sh](https://skills.sh).

Use `execute_code` to run CLI commands for skill management. Use `read_file` and `list_files` to inspect installed skill contents.

**Setup**

Before using external skills, install the CLI once:

```
npx skills
```

This is a one-time setup. Use `list_files` to check if the CLI has already been installed before running it again.

**Finding skills**

Search for skills by keyword:

```
npx skills find <keywords>
```

This queries the skills index, shows matching skills, and displays install instructions. Use this when you need a capability you don't currently have, or when the user asks you to find a skill for a specific purpose.

**Installing a skill**

Install a skill from a repository:

```
npx skills add <owner/repo>
```

For example:

```
npx skills add https://github.com/twostraws/swiftui-agent-skill
```

This downloads the repository, detects skills within it, copies files locally, and makes them available for use.

Some repositories contain multiple skills. Install a specific one using:

```
npx skills add <owner/repo> --skill <skill-name>
```

For example:

```
npx skills add https://github.com/twostraws/swiftui-agent-skill --skill swiftui-pro
```

After installing, read the skill's files to understand what instructions and workflows it provides, then follow them.

**Listing installed skills**

See what skills are currently installed:

```
npx skills list
```

This shows installed skills, target agent, and install location.

**Removing a skill**

Remove a skill you no longer need:

```
npx skills remove <skill-name>
```

**Workflow**

When you need a capability you don't have:

1. Search for relevant skills: `npx skills find <keywords>`
2. Review the results and pick the best match
3. Install it: `npx skills add <owner/repo>`
4. Read the installed skill files to understand its instructions
5. Follow the skill's instructions using your existing tools

When the user asks you to remove or manage external skills:

1. List installed skills: `npx skills list`
2. Remove as requested: `npx skills remove <skill-name>`

**Important notes**

- External skills are instruction bundles that guide how you use your existing tools. They do not add new tools to your toolset.
- Always read an installed skill's files after installation to understand what it expects you to do.
- Use `set_memory` to remember which external skills you've installed so you don't re-install them on subsequent ticks.
- If a skill requires tools you don't have (e.g. trading tools when you only have web-access), use `list_skills` and `add_skills` to add the required platform skills first.
