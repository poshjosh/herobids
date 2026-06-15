---
name: aba
description: aba
argument-hint: aba
handoffs:
  - label: to aca
    agent: Tester
    prompt: The unstaged changes in the codebase represent the fix for one or more bugs. The fixed bug(s) have been documented in `docs/bug-reports`. The bug(s) relating to the unstaged changes are the most recent in that folder with status = FIXED. You can determine the most recent bugs because the files are number sequentially based on the date of the bug report and then a serial number for each day. Format is: `docs/bug-reports/yyyy/MM/dd/<TICKET_OR_SERIAL_NUMBER>-<BUG-DESCRIPTION>.md`. You can determine the status of each bug-report by reading the report. Your task is to analyse each bug report relating to unstagged changes and add tests to cover cases that caused each bug. After adding tests, update the bug report with the new status: CLOSED.
    send: true
    model: Claude Sonnet 4.6
---

- Dislay the current date/time UTC followed by  "I am aba"

- Search for and display the result of the last match of the 2026 world cup final.