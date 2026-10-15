# Draw

Draw owns a drawing's scene. Drive owns its identity, title, location, grants,
lifecycle, and versions after adoption.

## Language

- **Drawing**: The content document that stores one scene.
- **Scene**: The JSON body with `rectangles` and `lines`. Rectangle entries also
  include ellipses, diamonds, text, embedded images, and freehand strokes.
- **Node**: The Drive Node linked through `Drawing.node`. Use Drive's vocabulary
  from `suite/drive/CONTEXT.md` for grants, roles, versions, and lifecycle.

## Adoption status

This branch prepares the content adapter in `drive.py`. It does not register
`SPEC` in `drive_content_types` or enable Drive permission hooks for Drawing yet.
The `DriveContent` mixin supports this expand phase (§10.3).

Existing drawings retain their content, names, titles, and owner permissions.
Their node link remains empty until an explicit adoption migration. The legacy
title field stays available for that migration. Once activated, the adapter's
`legacy_fields` declaration freezes it. New titles then belong to Drive alone.

Activation must follow a migration that preserves drawing identities, binds
every drawing to its own node, carries titles and access across, and verifies
reciprocal links. The current public Drive facade has no operation to bind an
existing content document. Do not import private Drive modules to work around
that missing operation.

## Content and lifecycle

The adapter creates empty scenes, copies bodies, and supplies version snapshots
with schema `drawing/1`. Restore validates the entire scene before saving.
Scenes are limited to 64 MiB, 10,000 objects, and 100,000 freehand points in total.
The limits refuse a write. They never truncate the saved drawing.

Images currently contain embedded data URLs. They are copied and versioned with
the scene. Draw does not declare Drive media callbacks until its scene stores
Drive media references.

Node assignment and body deletion require the adapter's internal lifecycle
context. The mixin prevents reassignment of an existing node. Linked saves
require Edit, and successful body changes touch the node. Drive callbacks join
the caller's transaction and do not commit.

## Manual verification after activation

Use two ordinary users and an isolated Suite site with a recorded backup.

1. Adopt an existing drawing. Verify its name, title, owner, and scene survive.
2. Create a drawing through Files. Reload it and compare its scene.
3. Copy the drawing. Verify the copy has its own identity and the same artwork.
4. Save a version, edit, and restore it. Verify only the scene changes.
5. Grant the second user Read. Verify reads succeed and body writes fail.
6. Grant Edit, then revoke it. Verify subsequent writes fail without data loss.
7. Attempt node reassignment and generic document deletion. Verify both fail.
8. Trash and restore through Files. Verify the scene survives. Purge only a
   disposable drawing and verify its body has no Deleted Document copy.

These journeys have not run. The current development Bench still serves the
original Draw checkout. Do not migrate that site to test this preparation.
