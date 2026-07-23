from __future__ import annotations

import json

import click
import frappe
from frappe.commands import pass_context
from frappe.exceptions import SiteNotSpecifiedError
from frappe.utils.bench_helper import CliCtxObj

from posawesome.posawesome.api.pos_maintenance import (
    collect_pos_operational_health,
)


@click.command("posawesome-doctor")
@click.option(
    "--pos-profile",
    default=None,
    help="Limit submission-ledger checks to one POS Profile.",
)
@click.option("--json-output", is_flag=True, help="Print machine-readable JSON.")
@pass_context
def posawesome_doctor(
    context: CliCtxObj,
    pos_profile: str | None,
    json_output: bool,
):
    """Check POS worker, queue, and durable submission health without mutation."""

    if not context.sites:
        raise SiteNotSpecifiedError

    unhealthy = False
    for site in context.sites:
        try:
            frappe.init(site)
            frappe.connect()
            health = collect_pos_operational_health(
                pos_profile,
                include_request_details=True,
            )
            queue = health["queue"]
            unhealthy = unhealthy or bool(
                queue.get("error")
                or (
                    health.get("background_submission_enabled")
                    and not queue.get("default_worker_available")
                )
            )
            if json_output:
                click.echo(json.dumps(health, indent=2, default=str))
                continue

            click.echo(f"Site: {site}")
            click.echo(
                "Submission mode: "
                f"{health['submission_mode']} "
                f"(background enabled: {health['background_submission_enabled']})"
            )
            click.echo(
                "Workers: "
                + ", ".join(
                    f"{name}={count}"
                    for name, count in queue["workers"].items()
                )
            )
            click.echo(
                "Queue depth: "
                + ", ".join(
                    f"{name}={count}"
                    for name, count in queue["queue_depth"].items()
                )
            )
            click.echo(
                f"Submission jobs: {queue['submission_jobs']} | "
                f"active ledgers: {health['active_submission_count']} | "
                f"oldest age: {health['oldest_active_age_seconds']}s"
            )
            if queue.get("error"):
                click.echo(queue["error"], err=True)
            if (
                health.get("background_submission_enabled")
                and not queue.get("default_worker_available")
            ):
                click.echo(
                    "No default worker is online. New POS submissions will use "
                    "the synchronous fallback; use `bench start` for the full "
                    "development runtime.",
                    err=True,
                )
        finally:
            frappe.destroy()

    if unhealthy:
        raise click.ClickException("POS operational health checks reported warnings.")


commands = [posawesome_doctor]
