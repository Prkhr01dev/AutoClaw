---
name: website_monitor
description: Monitor a website for changes and notify the user
triggers:
  - monitor
  - watch website
  - check url
---

# Website Monitor Skill

## When to Use
Use this skill when the user asks you to monitor a website, check for changes, or watch a URL for updates.

## Procedure

1. **Parse the request**: Extract the target URL and what specifically to monitor (content changes, status code, presence of specific text).

2. **Create a scheduled task**: Set up a cron job that runs at the requested interval (default: every 30 minutes).

3. **On each check**:
   - Use `browser_tool` to navigate to the URL
   - Extract the relevant content or take a screenshot
   - Compare with the previous check stored in memory
   - If changes detected, notify the user via the messaging gateway

4. **Store state**: Save the last known state in the database for comparison.

## Example Plan
```json
{
  "reasoning": "User wants to monitor example.com for price changes. I'll set up a recurring check.",
  "actions": [
    {
      "tool": "browser_tool",
      "params": { "action": "extract_text", "url": "https://example.com/pricing", "selector": ".price" }
    }
  ],
  "response": "I've set up monitoring for the pricing page. I'll check every 30 minutes and notify you of changes."
}
```
