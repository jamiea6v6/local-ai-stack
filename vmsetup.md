# VM setup — Proxmox with P106-100 passthrough

How to give a Debian 13 guest one or two P106-100 cards under Proxmox VE, so that `install-stack.md`
and the scripts work inside the VM exactly as on bare metal.

> **Status: untested draft.** These steps follow general Proxmox/VFIO practice and have not been run
> end to end for this stack. Treat every command as something to confirm, and fill in the
> "Record on first run" table at the bottom so the next person can reproduce it. Proxmox menus and
> package names change between releases; if something differs, trust what your system prints.

## How it works

The Proxmox **host** does not use the card. It binds the card to a placeholder driver (`vfio-pci`)
and hands the whole PCIe device to the VM. The **guest** then loads its own normal NVIDIA driver,
exactly as on a physical machine. So the host installs no NVIDIA driver for this, and the guest does
the driver step in `install-stack.md` §2.

The P106-100 has no display outputs. The VM gets its console from Proxmox's emulated display, and the
card is used only for compute.

---

## Part 1 — Proxmox host

### 1.1 BIOS/UEFI

- Enable **VT-d** (Intel) or **AMD-Vi / IOMMU** (AMD).
- If available, enable **Above 4G Decoding**.
- Put another GPU or an iGPU in charge of the host console if you want one; the P106 cannot.

### 1.2 Turn IOMMU on in the kernel

Find out which bootloader the host uses:

```bash
proxmox-boot-tool status        # systemd-boot entries listed -> use the first block below
```

- **GRUB** (typical for non-ZFS root): edit `/etc/default/grub`, set
  `GRUB_CMDLINE_LINUX_DEFAULT="quiet intel_iommu=on iommu=pt"`, then `update-grub`.
- **systemd-boot** (typical for ZFS root on UEFI): add `intel_iommu=on iommu=pt` to the single line in
  `/etc/kernel/cmdline`, then `proxmox-boot-tool refresh`.
- **AMD:** IOMMU is normally on by default on recent kernels; `iommu=pt` is optional.

Reboot, then confirm:

```bash
dmesg | grep -e DMAR -e IOMMU        # should mention IOMMU enabled
```

### 1.3 Load the VFIO modules

Add these lines to `/etc/modules`:

```
vfio
vfio_iommu_type1
vfio_pci
```

(Older guides also list `vfio_virqfd`. On newer kernels it is built into `vfio`; if `modprobe`
complains about it, leave it out.)

### 1.4 Check the IOMMU groups

```bash
for g in /sys/kernel/iommu_groups/*; do
  echo "group ${g##*/}"
  for d in "$g"/devices/*; do echo "  $(lspci -nns "${d##*/}")"; done
done
```

Each P106 should sit in a group with nothing else except its own PCIe root port or bridge. If it
shares a group with other devices, try another slot first. The kernel option
`pcie_acs_override=downstream,multifunction` splits groups artificially, but it weakens isolation
between devices, so use it only as a last resort.

### 1.5 Bind the cards to vfio-pci

```bash
lspci -nn | grep -i nvidia           # the P106-100 shows as [10de:1c07]
```

Create `/etc/modprobe.d/vfio.conf`:

```
options vfio-pci ids=10de:1c07
```

Create `/etc/modprobe.d/blacklist-gpu.conf`:

```
blacklist nouveau
blacklist nvidia
blacklist nvidiafb
```

```bash
update-initramfs -u -k all
reboot
lspci -nnk -d 10de:1c07              # each card must say: Kernel driver in use: vfio-pci
```

Notes:
- `ids=` binds **every** card with that ID, which is what you want for two P106s going to one VM.
  To keep one card on the host, bind by PCI address instead (for example with `driverctl`); I have
  not tested that here.
- If the host's own display GPU is also NVIDIA, blacklisting `nvidia` takes it away. Use an iGPU, a
  non-NVIDIA card, or work over SSH.

---

## Part 2 — create the VM

Settings (Proxmox GUI names; the `qm` equivalents are below):

| Tab | Setting | Value |
|---|---|---|
| OS | ISO | Debian 13 netinst |
| System | Machine | `q35` |
| System | BIOS | `OVMF (UEFI)` |
| System | EFI disk | add one; **untick "Pre-Enroll keys"** so Secure Boot is off |
| System | SCSI controller | VirtIO SCSI single |
| System | Qemu Agent | on |
| Disks | Size | enough for your model library; `gemma4:e4b-it-qat` alone is 6.1 GB, so 80 GB or more is comfortable |
| CPU | Type | `host`, 4 or more cores |
| Memory | Size | 16 GB or more, **ballooning off** (see `MANIFEST.md` §3 for RAM staging) |
| Network | Model | VirtIO |
| Display | (Hardware tab) | leave the default; the card has no outputs |

Add the cards: **Hardware → Add → PCI Device → Raw Device**, pick the P106, tick **PCI-Express**
(needs `q35`). Leave **Primary GPU** unticked. Repeat for a second card.

CLI equivalent (replace `<vmid>` and the addresses with yours from `lspci`):

```bash
qm set <vmid> -hostpci0 0000:01:00.0,pcie=1
qm set <vmid> -hostpci1 0000:02:00.0,pcie=1      # second card, if any
qm set <vmid> --onboot 1
```

Install Debian 13 from the ISO (xfce is optional).

---

## Part 3 — inside the guest

1. Follow `install-stack.md` §1 and §2 (base packages, then the NVIDIA driver). Also:
   ```bash
   sudo apt install -y qemu-guest-agent
   sudo systemctl enable --now qemu-guest-agent
   ```
2. Confirm the guest sees each card:
   ```bash
   lspci -d 10de:1c07
   nvidia-smi -L
   vulkaninfo --summary
   ```
3. Continue at `install-stack.md` §3 (bootstrap), including §4 (lingering for the shim), §5 and §6.
4. Run `./verify-stack.sh --profile p106`.

## Two cards

Ollama sees both. `docs/FRIEND-KIT.md` §4 covers the two strategies: one card per model (start here)
or spreading one model across both with `OLLAMA_SCHED_SPREAD=1`. Measure with
`ollama run <model> --verbose` before keeping the spread, since two cards add room, not speed.

---

## Troubleshooting

| Symptom | Likely cause | What to try |
|---|---|---|
| VM will not start; "group not viable" or similar | the IOMMU group contains a device that is not bound to vfio | bind the other devices too, or move the card to another slot |
| `nvidia-smi` in the guest finds no device | module not loaded: Secure Boot on, or headers missing | check `dmesg \| grep -i nvrm` in the guest; make sure the EFI disk was created without pre-enrolled keys; install `linux-headers-amd64` |
| `lspci` in the guest shows no card | device not added, or `pcie=1` without `q35` | recheck Hardware tab and machine type |
| the card is stuck after a guest *reboot* | some cards do not reset cleanly | shut the VM down and start it again; if that fails, reboot the host. I do not know whether the P106 behaves this way, so note what you see. |
| model loads slowly | mining cards often have a reduced PCIe link | check `LnkSta` in `sudo lspci -vv -d 10de:1c07` |
| host console disappeared | the host used an NVIDIA card that is now blacklisted | use an iGPU, another vendor's GPU, or SSH |
| cannot snapshot or live-migrate the VM | passthrough devices usually prevent it | use stopped-VM backups |

---

## Record on first run

| Item | Value |
|---|---|
| Proxmox VE version | |
| Host kernel (`uname -r`) | |
| Bootloader (GRUB / systemd-boot) | |
| IOMMU group of each card | |
| Guest `nvidia-smi` driver version | |
| `verify-stack.sh --profile p106` result | |
| Anything in this file that was wrong | |
