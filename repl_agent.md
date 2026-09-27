## Requirements for davai

### davai What?

davai is a cli repl tui in javascript that supports agentic usage for engineering applications.

### Features

  1. clean cli tui that is async native, beautiful and responsive
  2. configured via .env in DAVAI_HOME directory
  3. Supports openai, gemini, grok, anthropic api backends
  4. Project grounding included in 1st prompt
  5. Write access for tools is confined to subdir of current dir and DAVAI_RO_DIRS is a pathlike list of directories that agent can read the files.
  6. Records session logs in $DAVAI_HOME/sessions
  7. artifacts are ``` delimited outputs of llm, if agent has completed it's work the artifact can be copied to clipboard or saved as file.
  8. Don't use the tool interface of the llm, all operations are encoded as da_ops block, all operations are atomic and reversable(except shell which require approval) and if there is any problem the batch is killed and llm is prompted to resubmit
  9. Suport vision if llm does
  10. Loosely based on da_code legacy repl
  11. roll your own harness no frameworks
  12. granular context management and display system with auto-compact
  13. operator can use repl to run commands "sh dir" and result lands gets added to context
  14. pastes are consumed, numbers
  15. model comand shows options and allows tweaking settings

```da_ops
{
  [
    {"read": "/path_to_file", "lines": [min, max]},
    {"write": "/path_to_file", "text": "some text"},
    {"replace": "/path_to_file", "old": "old text", "new": """def new_func(value: str)
    return "new_func worked"
"""},
    {"list": "/path_to_dir", "max": nmax},
    {"grep": "/path_for_grep", "text": "def somefunc"},
    {"glob": "/path_for_glob", "text": "**.py"},
    {"shell": "command tto run"}
  ]
}
```