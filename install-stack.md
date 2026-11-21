# Install stack — Debian 13 on a P106-100 box

This file covers only what the scripts cannot do (OS, driver, reboot), then hands over to them.
Everything else is in `bootstrap.sh`, `install-harness.sh` and `verify-stack.sh`; do not repeat their
steps by hand.

> **Status.** `bootstrap.sh`, `install-harness.sh` and `verify-stack.sh` have been run on real boxes
> (see the log in `docs/WORKPLAN.md`). The driver steps in §2 follow general Debian practice and have
> **not** yet been run end to end on a fresh VM. On the first fresh run, confirm each command and fix
> this file with what actually happened.

Running in a Proxmox VM with GPU passthrough? Do `vmsetup.md` first, then come back to §1.

---

## 1. Base system

Debian 13 (trixie). A desktop (xfce) is optional; the stack does not need one.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ca-certificates python3-venv pciutils vulkan-tools
. /etc/os-release && echo "$PRETTY_NAME"      # must say Debian GNU/Linux 13
```

`pciutils` provides `lspci` and `vulkan-tools` provides `vulkaninfo`; `verify-stack.sh` uses both.

## 2. NVIDIA driver (Vulkan path)

The pin is **550.163.01** and it is deliberate: the 570+ requirement in Ollama's docs applies to CUDA,
and this stack runs the Vulkan path. Read `MANIFEST.md` §2 before changing it.

Debian ships the driver in the `non-free` component. Make sure `contrib non-free non-free-firmware`
are in the `Components:` line of `/etc/apt/sources.list.d/debian.sources`, then:

```bash
sudo apt update
apt-cache policy nvidia-driver                # check the candidate version against MANIFEST §2
sudo apt install -y linux-headers-amd64 nvidia-driver
sudo reboot
```

If the candidate version is not 550.163.01, stop and decide deliberately; do not install blindly.
Secure Boot must be off (or the kernel module signed), or the module will not load.

After the reboot:

```bash
lspci -d 10de:1c07          # the P106-100 (one line per card)
nvidia-smi                  # driver version, 6144 MiB per card
vulkaninfo --summary        # lists the card as a Vulkan device
ls /usr/share/vulkan/icd.d/nvidia_icd.json
```

If `vulkaninfo` lists no NVIDIA device, the Vulkan ICD is missing; see Troubleshooting.

## 3. Clone and bootstrap

```bash
git clone https://github.com/jamiea6v6/local-ai-stack.git ~/local-ai-stack
cd ~/local-ai-stack
./bootstrap.sh --dry-run                           # read the plan first
./bootstrap.sh --system --install-ollama --pull-models
```

- `--system` runs root steps (it will ask for your sudo password).
- `--install-ollama` downloads Ollama's install script and pipes it to `sh`. If you would rather read
  it first or install Ollama yourself, leave the flag out.
- `--pull-models` downloads the models named in `harness/models.json` (several GB).
- Every step is idempotent; a second run should report no actions.

## 4. Keep the shim running on a headless box

The shim is a user systemd unit. A user unit only runs while that user has a session, unless
lingering is enabled. `bootstrap.sh` does not set this.

```bash
sudo loginctl enable-linger "$USER"
systemctl --user status ollama-v1-shim
```

## 5. Install the workflow files

```bash
./install-harness.sh --dry-run
./install-harness.sh
```

This copies `harness/prompts/`, `harness/domains/` and `harness/bin/` into `~/.pi/agent/`. An
existing file that differs is backed up with a timestamp; a symlink is left alone unless `--force`.

## 6. Verify

```bash
./verify-stack.sh --profile p106
```

Expect exit 0 with no FAIL lines. SKIPs are allowed; the usual ones are `pi` not on a non-login PATH,
no `mcu-domain` checkout, and `vulkaninfo` not installed. A FAIL is information: read the line and fix
that item. Do not record a fixed pass count; it changes as checks are added. For one example of a
real run, see the 2026-11-16 brain1 entry in `docs/WORKPLAN.md`.

`verify-stack.sh` also checks that the installed prompts, domains and bin scripts match the repo.

## 7. Daily use

Start `pi` inside a project directory. Files land in that directory.

| Command | What it does | File written |
|---|---|---|
| `/research <domain> <topic>` | one-question-at-a-time discovery, no code | `BRIEF.md` |
| `/plan <domain> "<task>"` | gathers evidence with the domain's PREFLIGHT, plans, stops | `PLAN.md` |
| (you) | edit the line `APPROVED: none` to e.g. `APPROVED: steps 1-3` | `PLAN.md` |
| `/do <n>` | runs approved step *n* and its gate | a `DONE n:` line in `PLAN.md` |
| `/handoff` | writes a summary from `PLAN.md` for the next session | `HANDOFF.md` |
| `/debug [run <command>]` | environment snapshot, optionally a timed command run | `DEBUG.md` |
| `/deploy` | detects project files and how to run them | `DEPLOY.md` |
| `/document` | exports the current session transcript | `session-content.md` |

Available domains are the files in `~/.pi/agent/domains/` (currently `tui-dsp`).

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `nvidia-smi` fails after the driver install | not rebooted, Secure Boot on, or kernel headers missing | reboot; disable Secure Boot; `sudo apt install linux-headers-amd64`, then `sudo dpkg-reconfigure nvidia-kernel-dkms` |
| `vulkaninfo` shows no NVIDIA device | Vulkan ICD package missing | `apt-cache search nvidia vulkan`; install the ICD package, then check `ls /usr/share/vulkan/icd.d/` |
| `verify-stack.sh`: `libportaudio2 missing` | root step not run | `./bootstrap.sh --system` |
| `verify-stack.sh`: prompts or domains differ from the repo | edited the installed copy, or never installed | edit the repo copy, then `./install-harness.sh` |
| shim not running after logout or reboot | lingering not enabled | `sudo loginctl enable-linger "$USER"` |
| first completion takes about a minute | cold model load | wait; later requests are faster |
| card not visible inside a Proxmox VM | passthrough problem | see `vmsetup.md` |
