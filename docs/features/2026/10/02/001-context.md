herobids = /Users/chinomso.ikwuagwu/dev_ai/herobids/ (staging.openaidom.com, openaidom.com)

traderton = /Users/chinomso.ikwuagwu/dev_ai/traderton/ (traderton.com)

traderton-skills = /Users/chinomso.ikwuagwu/dev_ai/traderton-skills/ (https://github.com/traderton/skills)

openaidom-skills = /Users/chinomso.ikwuagwu/dev_ai/openaidom-skills/ (https://github.com/openaidom/skills)


Infra code is usually in infra/hetzner of the respective repository e.g herobids/infra/hetzner

Useful infra scripts are in infra/hetzners/scripts/ of the respective repository e.g infra/hetzner/scripts/_ssh_opts.sh

Useful scripts are in scripts/shell/ for example: 

- run scripts are in scripts/shell/run
- test scripts are in scripts/shell/tests

The following tests must pass at the very end of all your work:

```sh
traderton/scripts/shell/tests/run-all-tests.sh --e2e
traderton/scripts/shell/tests/run-extra-tests.sh --all
traderton/scripts/shell/tests/run-integration.sh
herobids/scripts/shell/tests/run-all-tests.sh --e2e
herobids/scripts/shell/tests/run-extra-tests.sh --all
```





