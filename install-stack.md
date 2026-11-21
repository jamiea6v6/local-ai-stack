# Install Stack — Debian 13 (trixie) xfce + P106-100 GPU

Fresh install sequence for Skynet / Brain1 local-ai-stack configuration.
Based on MANIFEST.md §2–§4 (pins captured 2026-11-14). Idempotent where possible.

---

## 0. Prerequisites

- Hardware: NVIDIA P106-100 (GP106, compute_cap 6.1, 6144 MiB VRAM, no display outputs)
- OS: Debian 13 (trixie) with xfce desktop
- User: `jamie` (no passwordless sudo; use `su` or `sudo` for root steps)

---

## 1. System Package Update + Essentials

```bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
  curl wget git vim tmux htop bash-completion \
  advanced-aoe-tools xfsproj e2fsprogs \
  util-linux apt-transport-https ca-certificates gnupg \
  lsb-release software-properties-common

# Verify Debian 13
cat /etc/os-release  # must show VERSION_ID=13
```

---

## 2. NVIDIA P106-100 Vulkan Driver (PINNED)

**Critical: Install driver `550.163.01` — do not "upgrade" to 570+ unless you need CUDA.**

The P106-100 at compute_cap 6.1 is fully supported by **550.163.01** for the Vulkan path.
The 570+ requirement applies to CUDA only; your stack runs Vulkan path via the Ollama shim.

```bash
# Method A: nvidia-driver package (pulls latest 550.xx from Debian repos)
sudo apt install -y nvidia-driver-550

# Method B: Specific 550.163.01 (if you need exact pin)
#   Download runfile from NVIDIA site or use apt pinning
#   See MANIFEST.md §2 for the exact driver pin rationale

# Reboot to load the driver
sudo reboot
```

**Verify after reboot:**

```bash
lspci -d 10de:1c07   # should show NVIDIA P106-100
nvidia-smi           # should show driver 550.163.01, 6144 MiB VRAM
vulkaninfo           # should detect Vulkan device(s)
```

**Why not 570+?** 
MANIFEST.md §2: "The 570 requirement applies to the **CUDA** path only. brain1 runs the **Vulkan** path, which has no such requirement. What actually decides whether a model runs is **VRAM**, not the driver."

---

## 3. Ollama Installation

```bash
# Install Ollama (official method)
curl -fsSL https://ollama.com/install.sh | sh

# Start the daemon
ollama serve &

# OR systemd:
systemctl start ollama.service
systemctl enable ollama.service

# Verify it's running
ollama list          # should show any pulled models
curl -fsS http://127.0.0.1:11434/api/version  # API responding
```

**Ports (MANIFEST.md §4):**

| Port | What |
|---|---|
| 11434 | Ollama native API — the shim only |
| 11435 | the shim's OpenAI-compatible API — Pi (`models.json` baseUrl) |

---

## 4. Python + Audio Dependencies

Your stack needs PortAudio for `sounddevice` in the Python venv.

```bash
# System-level PortAudio (required before venv audio imports)
sudo apt install -y libportaudio2 python3-pyaudio

# If bootstrap.sh --system is used, it also checks for this:
#   lint: "$LDCONF -p 2>/dev/null | grep libportaudio >/dev/null"
#   p "libportaudio2" || f "libportaudio2 missing"
```

---

## 5. Clone + Bootstrap the Stack

```bash
# Clone the repo (source of truth)
git clone https://github.com/jamiea6v6/local-ai-stack.git ~/local-ai-stack
cd ~/local-ai-stack

# Bootstrap the full environment:
#   - Node 22 under ~/.local/node
#   - Pi coding agent @earendil-works/pi-coding-agent@1.4.0
#   - Ollama shim + systemd unit
#   - Models from models.json (gemma4:e4b-it-qat, llama3.2:3b)
#   - Venv with numpy/scipy/sounddevice/textual
#   - Arduino CLI + cores + libraries
#   - GPU/P106-100 detection + validation
#   - libportaudio2 check
./bootstrap.sh

# With --system flag if you want root steps included:
#   ./bootstrap.sh --system
```

---

## 6. Install Harness Prompts/Domains/Bin

```bash
# Install the harness prompt/domain/bin infrastructure from local source
# to ~/.pi/agent/ (7 prompts, 1 domain, 5 bin scripts)
./install-harness.sh
```

**What this installs:**

| Category | Files |
|---|---|
| Prompts | research.md, plan.md, do.md, document.md, handoff.md, deploy.md, debug.md (7 files) |
| Domains | tui-dsp.md (1 file) |
| Bin scripts | preflight.sh, deploy.sh, document.sh, handoff.sh, debug.sh (5 scripts) |

**Idempotent:** Second run reports all files "present"; backup with timestamp on overwrite.
`--dry-run` mode available to preview without changes.
`--force` mode to overwrite without backing up.

---

## 7. Pull Models + Start Services

```bash
# Start Ollama if not already running
ollama serve

# Pull the daily driver model
ollama pull gemma4:e4b-it-qat   # 6.1 GB, ~30 tok/s, QAT build

# Pull fallback model
ollama pull llama3.2:3b         # 3B params, fast, unreliable tool use

# Verify models are loaded
ollama list
```

---

## 8. Final Verification

```bash
# Run the complete stack verification
./verify-stack.sh
```

**Expected output** (per MANIFEST.md capture):

```
31 passed, 3 failed, 1 skipped
```

**3 pre-existing FAILs** (unrelated to fresh install):

| File | Issue | Source |
|---|---|---|
| `models.json` | Brain1-specific `gpt-oss:20b` model added | locals-only, not on GitHub |
| `settings.json` | `lastChangelogVersion: "1.4.0"` vs repo `"1.1.0"` | Brain1 config drift |
| `AGENTS.md` | `@STACK_DIR@` template not resolved (uses `/data/jamie/local-ai-stack/...`) | template for host-agnostic copy |

**1 SKIP** (expected):

| Item | Reason |
|---|---|
| extensions/ is a symlink | managed elsewhere (`/data/jamie/ai-stack/pi-agent/extensions`) |

**31 PASS** confirms: Debian 13, Node 22, Ollama 0.40.12, shim active, models loaded, PI 1.4.0, GPU present, VRAM correct, Vulkan available, libportaudio2 installed, Arduino CLI + cores + libraries, grader 11/11, MCU selftest green.

---

## 9. Post-Install / Daily Use

```bash
# Daily work flow
/research <domain> <topic>    # write BRIEF.md, get READY /plan command
/plan <domain> "<task>"       # gather evidence (PREFLIGHT), write PLAN.md
HANDOFF                     # generate HANDOFF.md from PLAN.md
DEBUG                       # capture runtime snapshot (.debug.md)
DEPLOY                      # generate DEPLOY.md from project files
DOCUMENT                    # export session content (.session-content.md)
```

**Constraints from AGENTS.md:**

- No commits/pushes/installs of third-party code without explicit request
- Never expose/commit `/data/jamie/.config/opencode/secrets.env`
- Public commits: no LAN IPs, `/home//data/jamie` paths, real names, raw transcripts
- Git over HTTPS push hangs (timeout 45 → RC 124). Prefer GitHub API/MCP tools for publish.
- Access: Brain1 only `ssh -o BatchMode=yes -o ConnectTimeout=5 jamie@192.168.1.86 '...'`; no SSH to Skynet
- Pi template/tool rules: prompts in `~/.pi/agent/prompts/`, domains in `~/.pi/agent/domains/`

---

## 10. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `ollama serve` hangs / no model loaded | Driver not loaded after reboot | Reboot after `nvidia-driver-550` install; verify `nvidia-smi` |
| `import sounddevice` → `PortAudio library not found` | `libportaudio2` not installed | `sudo apt install -y libportaudio2 python3-pyaudio` |
| `verify-stack.sh` FAIL on models.json drift | Brain1-specific gpt-oss:20b in models.json | Ignore; locals-only, not published to GitHub |
| `verify-stack.sh` FAIL on settings.json version | `1.4.0` vs `"1.1.0"` in repo | Brain1 config; ignore or update via bootstrap `--force-config` |
| GPU seen but VRAM wrong | Wrong NVIDIA driver installed | Reinstall `nvidia-driver-550`; verify `550.163.01` |
| `ollama` not found after install | PATH not refreshed | `source ~/.bashrc` or `ollama serve` in new shell |

---

## File Inventory (this repo: `~/local-ai-stack/`)

| File | Purpose |
|---|---|
| `bootstrap.sh` | Full environment install (Node, Pi, Ollama shim, models, venv, GPU, Arduino) |
| `install-harness.sh` | Harness prompts/domains/bin to `~/.pi/agent/` (new filler) |
| `verify-stack.sh` | Stack validation (30+ checks, PASS/FAIL/SKIP) |
| `install-stack.md` | **This file** — fresh install sequence for Debian 13 xfce + P106-100 |
| `MANIFEST.md` | Pins + why each version is pinned (captured 2026-11-14) |
| `DECK.md` | Presentation/explainable deck (house format) |
| `systemd/ollama-v1-shim.service` | Ollama shim systemd unit |

---

## Quick Command Sequence (one-liner)

```bash
# Fresh Debian 13 xfce + P106-100:
sudo apt update && sudo apt upgrade -y && \
  curl -fsSL https://ollama.com/install.sh | sh && \
  sudo apt install -y libportaudio2 python3-pyaudio && \
  sudo reboot && \
  git clone https://github.com/jamiea6v6/local-ai-stack.git ~/local-ai-stack && \
  cd ~/local-ai-stack && \
  ./bootstrap.sh && \
  ./install-harness.sh && \
  ollama serve && \
  ollama pull gemma4:e4b-it-qat && \
  ollama pull llama3.2:3b && \
  ./verify-stack.sh
```

**Note:** The `sudo reboot` is required after driver install. After reboot, resume the sequence from `git clone`.

---

*Generated from MANIFEST.md §2–§4 (pins captured 2026-11-14) + bootstrap.sh + install-harness.sh workflow.*