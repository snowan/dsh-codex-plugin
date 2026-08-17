# Evaluations

Run deterministic gates:

```sh
npm run verify
```

Run live ChatGPT-authenticated App Server scenarios:

```sh
npm run build
node evals/run-real.mjs
```

Override the model with `DSH_CODEX_EVAL_MODEL`. The live script prints JSON and
does not write credentials or session content to this repository.
