"""Create the web backend's Oracle Always Free VM, trying until Oracle has room.

Ampere A1 machines in a home region are often "Out of capacity". The console
then makes you click Create again and again; this does it every ~90 s, going
round the availability domains, and stops at the first VM it gets.

Every other try asks for half the allowance (1 OCPU, 6 GB), which Oracle has
room for far more often; that VM can be grown to the full 2 OCPU / 12 GB later
(Edit shape in the console, or update_instance) without being made again.

Reads ~/.oci/config (API key auth). Run with the OCI SDK's Python:
    ~/.weatherts/oci-venv/Scripts/python.exe deploy/oracle_create_vm.py
"""
from __future__ import annotations

import itertools
import sys
import time
from datetime import datetime
from pathlib import Path

import oci

NAME = "weatherts-api"
VCN = "vcn-20260623-2115"
SUBNET = "public-subnet"
SHAPE = "VM.Standard.A1.Flex"
SIZES = [(2, 12), (1, 6)]         # the whole Always Free A1 allowance, then half of it
BOOT_GB = 50                      # well inside the 200 GB of free block storage
SSH_KEY = Path.home() / ".ssh" / "weatherts_oracle.pub"
WAIT_S = 90


def log(*a: object) -> None:
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def main() -> int:
    cfg = oci.config.from_file()
    tenancy = cfg["tenancy"]
    idn = oci.identity.IdentityClient(cfg)
    cmp = oci.core.ComputeClient(cfg)
    net = oci.core.VirtualNetworkClient(cfg)

    for i in cmp.list_instances(tenancy).data:
        if i.display_name == NAME and i.lifecycle_state not in ("TERMINATED", "TERMINATING"):
            log("already there:", i.lifecycle_state, i.id)
            return report(cmp, net, tenancy, i.id)

    vcn = next(v for v in net.list_vcns(tenancy).data if v.display_name == VCN)
    subnet = next(s for s in net.list_subnets(tenancy, vcn_id=vcn.id).data if s.display_name == SUBNET)
    image = cmp.list_images(
        tenancy, operating_system="Canonical Ubuntu", operating_system_version="24.04",
        shape=SHAPE, sort_by="TIMECREATED", sort_order="DESC",
    ).data[0]
    ads = [a.name for a in idn.list_availability_domains(tenancy).data]
    log("image", image.display_name, "| ADs", ", ".join(ads))

    # Each AD with the full size, then each with the half size, and round again.
    tries = itertools.cycle([(ad, size) for size in SIZES for ad in ads])
    for n, (ad, (ocpus, memory)) in enumerate(tries, 1):
        tag = f"try {n} {ad} {ocpus}/{memory}"
        details = oci.core.models.LaunchInstanceDetails(
            compartment_id=tenancy,
            availability_domain=ad,
            display_name=NAME,
            shape=SHAPE,
            shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(ocpus=ocpus, memory_in_gbs=memory),
            source_details=oci.core.models.InstanceSourceViaImageDetails(image_id=image.id, boot_volume_size_in_gbs=BOOT_GB),
            create_vnic_details=oci.core.models.CreateVnicDetails(subnet_id=subnet.id, assign_public_ip=True),
            metadata={"ssh_authorized_keys": SSH_KEY.read_text().strip()},
        )
        try:
            inst = cmp.launch_instance(details).data
            log(f"{tag}: launched", inst.id)
            return report(cmp, net, tenancy, inst.id)
        except oci.exceptions.ServiceError as e:
            msg = (e.message or "").lower()
            if "capacity" in msg:
                log(f"{tag}: out of capacity")
            elif e.status == 429:
                log(f"{tag}: too many requests, waiting longer")
                time.sleep(WAIT_S * 2)
            elif "limit" in msg or e.status in (400, 401, 404):
                # Something no retry will fix: say what it was and stop.
                log(f"{tag}: {e.status} {e.code}: {e.message}")
                return 1
            else:
                log(f"{tag}: {e.status} {e.code}: {e.message}")
        except Exception as e:  # noqa: BLE001 -- a dropped connection: keep trying
            log(f"{tag}: {type(e).__name__}: {e}")
        time.sleep(WAIT_S)
    return 1


def report(cmp, net, tenancy: str, instance_id: str) -> int:
    inst = oci.wait_until(cmp, cmp.get_instance(instance_id), "lifecycle_state", "RUNNING", max_wait_seconds=900).data
    att = cmp.list_vnic_attachments(tenancy, instance_id=instance_id).data[0]
    vnic = net.get_vnic(att.vnic_id).data
    log("RUNNING", inst.availability_domain, "public IP", vnic.public_ip)
    print(f"PUBLIC_IP={vnic.public_ip}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
