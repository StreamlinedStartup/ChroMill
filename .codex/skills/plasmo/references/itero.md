# Itero

Itero provides hosted extension testing, builds, and publishing. Use these references only for a requested Itero task. Read current service availability, plan limits, and account controls before configuring a workflow.

## TestBed

TestBed distributes staging archives to testers. Build and package the extension locally first. The guide describes uploading the archive, opening its install page, and sharing the generated link. Testers install Plasmo's software for managed updates.

Inspect the extension's access setting before sharing a link. The guide offers private team access. Do not upload an archive or send tester invitations without the user's authorization.

## Teams

The team guide covers team creation, invitations, joining, and role changes. Team owners and admins manage membership. It describes plan restrictions that need current account confirmation.

A documentation crawl does not authorize invitations, role changes, or paid plan changes. Prepare the requested membership change before an external action.

## Builder and GitHub integration

Upload the extension to Itero before connecting its GitHub repository. Grant the GitHub app access to the requested repositories. Link the extension to `<owner/repo>` separately from app installation.

The integration tracks a branch, with `main` as the documented default. Read build history and logs from the extension dashboard and GitHub commit status.

The guide describes one-to-one bindings between personal or team entities. A move from a personal account to a team can require removing the prior binding. Inspect existing connections before making changes. Account emails can affect commit attribution.

## Publisher

Publisher submits archives to Chrome, Firefox, and Edge stores. The docs mark it as beta and describe store-specific credentials. Read current provider instructions before obtaining credentials or changing OAuth configuration.

Prepare and test the archive before an authorized submission. Protect credentials through the project's chosen secret route. Do not copy example keys into logs, committed files, or extension bundles.

For GitHub-based submission through BPP, read [Workflows](workflows.md) and the current BPP documentation.

## MV2 to MV3 conversion

The converter examines the manifest and can scan code for MV2-only behavior. Read the output as migration findings rather than proof of compatibility. Test event handling, persisted state, permissions, and remote code after conversion.

The docs describe different features by plan. Make sure that the current account supports the requested operation before using the hosted converter.

## Manual upload API

The manual API accepts archives from a separate build pipeline. The guide limits it to a paid plan and supports BPP integration. Obtain the Itero credential through the authorized secret route.

The documented upload sequence is:

1. POST the `keys.itero` object to `https://itero.plasmo.com/api/submit/upload`.
2. PUT the archive to the returned signed URL with `Content-Type: application/zip`.
3. POST the `keys.itero` object to `https://itero.plasmo.com/api/submit/sign`.

Make sure that each response succeeds before the next request. Treat the signed URL as a secret. Stop after a failed request and inspect the response without printing credentials. Do not finalize an upload that did not complete successfully.

## Official sources

- [Itero overview](https://docs.plasmo.com/itero)
- [TestBed](https://docs.plasmo.com/itero/test-bed)
- [Teams](https://docs.plasmo.com/itero/team)
- [GitHub Extension Builder](https://docs.plasmo.com/itero/builder)
- [GitHub integration](https://docs.plasmo.com/itero/github)
- [Publisher](https://docs.plasmo.com/itero/publisher)
- [MV2 to MV3 converter](https://docs.plasmo.com/itero/mv2-to-mv3)
- [Manual API](https://docs.plasmo.com/itero/api)
