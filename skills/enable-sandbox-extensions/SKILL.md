---
name: enable-sandbox-extensions
description: Enables the sandbox's preinstalled pi extensions (Superpowers, pi-subagents, rpiv-todo, rpiv-ask-user-question) in the current workspace by writing .pi/settings.json, then prompts the user to run /reload. Use when the user wants the sandbox extensions enabled.
---

# Enable sandbox extensions

1. In the current workspace, create `.pi/settings.json`, or merge into the existing file.
   The `extensions` array must contain all of the following (keep any existing entries;
   skip ones already present):

```json
{
    "extensions": [
        "/home/pi/.pi/agent/git/github.com/obra/superpowers",
        "/home/pi/.pi/agent/npm/node_modules/pi-subagents",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question"
    ]
}
```

2. Verify the result parses: `jq . .pi/settings.json`

3. Tell the user: extensions enabled — run `/reload` to activate them in this session.
