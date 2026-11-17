# pi-dent-purse

A pi extension that collects per-provider LLM billing state (prices, balances, usage limits) and
serves it to other extensions and the user.

```sh
pi install npm:pi-dent-purse   # add it to pi's packages
pi -e npm:pi-dent-purse        # or try it for one run
```

[pi-dent-agent](https://www.npmjs.com/package/pi-dent-agent) bundles it: do not install both.

Requires Node 26 or later and a pi that provides the extension API.

## License

MIT
