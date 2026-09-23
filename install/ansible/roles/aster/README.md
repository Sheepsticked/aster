# Ansible role `aster`

A thin wrapper around `install/install.sh`. It ships the repository to `{{ aster_repo_dest }}` on the
appliance, runs the installer non-interactively, and asks `doctor.sh` whether the result is healthy. The appliance
keeps its data in `data/` inside that folder, like an install by hand.
`install.sh` stays the single source of truth for the host: the role never writes into `{{ aster_home }}`,
never uses `synchronize` and never deletes anything.

## Using it

```sh
# one appliance in an [aster] group, the secrets in a vault file
ansible-playbook -i inventory.ini install/ansible/playbook.yml --ask-vault-pass

# this machine, for trying the role out (no become, an appliance under /tmp)
ansible-playbook -i localhost, -c local -e aster_hosts=localhost -e aster_become=false \
  -e aster_repo_dest=/tmp/aster -e aster_admin_password=a-long-enough-password \
  install/ansible/playbook.yml
```

`aster_hosts` (default `aster`) is the pattern the second play runs on; the first play refuses to continue when
nothing in the inventory matches it, because a playbook whose pattern matches no host otherwise exits 0 having
done nothing.

## Variables

| Variable | Default | Is |
|---|---|---|
| `aster_source` | `local` | `local`: pack this checkout and send it. `git`: clone `aster_git_url` at `aster_git_version` on the host |
| `aster_src` | the repository this role is in | what `local` packs (tracked files when it is a git checkout, working-tree content) |
| `aster_repo_dest` | `/srv/aster` | the appliance's folder: the sources live and run there (`install.sh`, the host scripts, the build contexts) |
| `aster_git_url`, `aster_git_version` | the GitHub repository, `main` | `git` mode; use a tag for a release |
| `aster_home` | `{{ aster_repo_dest }}/data` | `--home`: where the appliance keeps its data |
| `aster_http_port` | `80` | `--http-port` (the controller runs as root in its container, so a port below 1024 binds; the old appliance's web UI on it is stopped) |
| `aster_image_source` | `pull` | `--build` or `--pull` (and `ASTER_IMAGE_SOURCE` in `.env`, which `update.sh` then follows) |
| `aster_image_ns`, `aster_version` | `sheepsticked`, `latest` | `ASTER_IMAGE_NS` / `ASTER_VERSION`: which images `--pull` pulls (a local build uses `aster`, `dev`) |
| `aster_sd_tuning` | `auto` | accepted and ignored: `install.sh` does not tune the host (swap, journald, `/tmp`) — see the README's "SD-card wear" |
| `aster_install_docker` | `false` | `--install-docker`: let the installer apt-install Docker when it is missing |
| `aster_rebuild` | `false` | `--rebuild`: build the images again even when they are there. **Recreates both containers, so calls drop** |
| `aster_start` | `true` | `false` passes `--skip-up`: everything but starting the containers |
| `aster_doctor` | `true` | run `doctor.sh` at the end; a problem fails the play |
| `aster_admin_password` | `""` | required on a **first** install; ignored afterwards, because the hash is already set |
| `aster_telegram_token` | `""` | optional; Settings → Telegram bot can set it later instead |
| `aster_become` | `true` | play-level `become` |

## Two things worth knowing

**Secrets never travel in the environment.** `ansible-playbook -vvv` prints a task's environment verbatim in its
EXEC line (`SECRET_THING=hunter2-topsecret /usr/bin/python3 …`). The password and
the Telegram token are therefore written to a 0600 temporary file on the appliance, handed to `install.sh` as
`ASTER_ADMIN_PASSWORD_FILE` / `ASTER_TELEGRAM_TOKEN_FILE`, and removed in an `always` block — including when the
installer fails. Keep both in a vault:

```sh
ansible-vault create group_vars/aster/vault.yml     # aster_admin_password: …
```

**`changed` is `install.sh`'s own answer.** Every step of the installer compares before it writes, and the last
line it prints is `CHANGED=<n>`; the role reports `changed` exactly when that number is not zero. The
number also counts a pulled image and a recreated container, so an update that replaced both containers cannot
report "nothing to do". An installer that exits 0 without printing the line has broken the contract this role
rests on, and the task fails rather than guessing what happened.

`--check` reports the installer and `doctor.sh` as *skipped* and everything before them honestly (the sources are
packed and compared, so a dry run does tell you whether the checkout on the appliance would change): `install.sh`
has no dry run of its own, and pretending otherwise would be a worse answer than saying nothing was checked.

In `git` mode the role comes from the checkout you run the playbook from while the installer comes from
`aster_git_version` on the appliance, so deploy a tag by checking that tag out and running *its* playbook: a newer
role can pass options an older `install.sh` does not have.
