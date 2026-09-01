# Mealie technical facts at C0

Frozen memory view for phase-1 evaluation. These facts describe only the code present at
`mealie-recipes/mealie@551a92a0317acf6c61ace0afde47312d99a0054b`; they do not describe any
evaluation task or post-C0 solution.

- extracted: `2026-09-01`
- slices: `api-contracts`, `invariants`, `data-ownership`, `config-flags`
- xmemory instance: `5f1dea7e-4daa-45f7-b667-758f4b33b960`
- schema SHA-256: `75c22bb0ed12eb4e829b1260b3b86426c20291b562d74e83141c824810c948e8`
- view policy: active facts only; high-confidence observed facts with code/test/doc evidence

## API contracts

### fact:ac-0001 — Root API composition

- Contract: the backend API is composed under a root `APIRouter(prefix="/api")` that includes
  the domain routers.
- Registration: router composition; authentication remains the responsibility of included routers.
- Evidence: `mealie/routes/__init__.py:20-35`.

### fact:ac-0002 — Class-based endpoints

- Contract: endpoint classes use `@controller(router)`; decorated methods are registered on that
  router and the controller instance is built through FastAPI dependency injection.
- Registration: class-based view registration; route paths and protection come from the supplied router.
- Evidence: `mealie/routes/_base/controller.py:20-44`.

### fact:ac-0004 — Repository-backed HTTP failures

- Contract: `HttpRepo` rolls back the repository session when a caught CRUD operation fails.
- Response behavior at C0: `NoResultFound` becomes HTTP 404; every other caught exception becomes
  HTTP 400.
- Evidence: `mealie/routes/_base/mixins.py:43-72`.

## Invariants

### fact:iv-0001 — Capability checks

- Rule: protected user operations must pass the corresponding capability check.
- Enforcement: `OperationChecks` checks household-management, management, invite, and organize
  capabilities; failure is HTTP 403.
- Evidence: `mealie/routes/_base/checks.py:6-40`.

### fact:iv-0002 — Ordinary-user tenant scope

- Rule: ordinary user repositories inherit the authenticated user's `group_id` and `household_id`.
- Enforcement: `BaseUserController` exposes both ids and `_BaseController.repos` passes them to
  `AllRepositories`.
- Evidence: `mealie/routes/_base/base_controllers.py:47-50,132-172`.

### fact:iv-0003 — Explicit admin scope

- Rule: admin controllers use deliberately unscoped repositories.
- Enforcement: `BaseAdminController.repos` constructs `AllRepositories(group_id=None,
  household_id=None)`; this convention is admin-only.
- Evidence: `mealie/routes/_base/base_controllers.py:175-189`.

### fact:iv-0004 — Scope must not be omitted

- Rule: group- and household-scoped repository constructors require callers to supply scope.
- Enforcement: `GroupRepositoryGeneric` and `HouseholdRepositoryGeneric` reject `NOT_SET` with
  `ValueError`; explicit `None` is the intentional unscoped value.
- Evidence: `mealie/repos/repository_generic.py:483-517`.

## Data ownership

### fact:do-0001 — Repository factory

- Ownership: `AllRepositories` is the central data-access factory for domain models.
- Scope behavior: its `group_id` and `household_id` are passed to cached concrete repository instances.
- Evidence: `mealie/repos/repository_factory.py:102-134`.

### fact:do-0002 — Automatic query scope

- Ownership: scoped SQLAlchemy models are accessed through `RepositoryGeneric` subclasses.
- Read behavior: `_filter_builder` automatically adds configured `group_id` and `household_id` to
  collection and single-record queries.
- Evidence: `mealie/repos/repository_generic.py:94-102,133-174`.

### fact:do-0003 — Recipe and organizer scope

- Ownership: recipes are group-and-household scoped; ingredient foods, ingredient units,
  categories, and tags are group scoped.
- Enforcement: `AllRepositories` chooses the corresponding concrete repository and supplies its scope.
- Evidence: `mealie/repos/repository_factory.py:130-160`.

### fact:do-0004 — Cross-household recipe data

- Ownership: recipe comments and recipe timeline events are group scoped.
- Reason declared in code: users may add them to recipes belonging to other households in the group.
- Evidence: `mealie/repos/repository_factory.py:148-173`.

### fact:do-0005 — Normalized recipe columns

- Model data: `RecipeModel.name_normalized` and `description_normalized` are derived fields; callers
  should not write them directly.
- Normalization at C0: `unidecode(value).lower().strip()[:255]`.
- Write behavior: constructor handling and SQLAlchemy `set` listeners maintain the columns.
- Migration rule: changes to the columns or their indexes require an Alembic revision.
- Evidence: `mealie/db/models/_model_base.py:19-23` and
  `mealie/db/models/recipe/recipe.py:164-166,223-228,271-281`.

### fact:do-0006 — Schema migrations

- Migration rule: Alembic autogeneration uses `SqlAlchemyBase.metadata`.
- Execution: online migrations use batch rendering and run inside a transaction.
- Evidence: `mealie/alembic/env.py:14-18,93-103`.

## Configuration flags

### fact:cf-0001 — Settings entry point

- Read location: runtime settings are obtained from the `lru_cache`-backed `get_app_settings()`
  factory, not by directly constructing `AppSettings`.
- Construction: the factory supplies the project `.env`, data directory, generated secrets, and DB provider.
- Evidence: `mealie/core/config.py:14-18,36-43` and
  `mealie/core/settings/settings.py:89-108,470-496`.

### fact:cf-0002 — Environment parsing

- Setting model: `AppSettings` uses `SettingsConfigDict(extra="allow",
  env_nested_delimiter="__")`.
- Construction: `app_settings_constructor` supplies secrets and initializes `DB_PROVIDER`.
- Evidence: `mealie/core/settings/settings.py:458,470-496`.

### fact:cf-0003 — LDAP readiness

- Default: `LDAP_AUTH_ENABLED=False`.
- Readiness: LDAP is enabled only when the flag is true and server URL, base DN, id attribute,
  mail attribute, and name attribute are present.
- Validation: unit tests cover disabled, missing-field, and ready cases.
- Evidence: `mealie/core/settings/settings.py:300-333`,
  `tests/unit_tests/test_config.py:262-277`, and
  `docs/docs/documentation/getting-started/installation/backend-config.md:75-91`.

### fact:cf-0004 — OIDC readiness

- Default: `OIDC_AUTH_ENABLED=False`.
- Readiness: OIDC requires enablement, client id, client secret, configuration URL, and user claim;
  a groups claim is additionally required when user/admin group filtering is configured.
- Validation: unit tests cover missing requirements and both group modes.
- Evidence: `mealie/core/settings/settings.py:337-386`,
  `tests/unit_tests/test_config.py:307-349`, and
  `docs/docs/documentation/getting-started/installation/backend-config.md:93-117`.

### fact:cf-0005 — Testing environment-backed settings

- Convention: after changing configuration environment variables with `monkeypatch`, tests call
  `get_app_settings.cache_clear()` before reading settings again.
- Evidence: `tests/unit_tests/test_config.py:12-26,267-277,339-349`.

### fact:cf-0006 — Configuration documentation

- Documentation: supported LDAP and OIDC environment variables and defaults are listed in the
  backend configuration reference.
- Evidence: `docs/docs/documentation/getting-started/installation/backend-config.md:75-117`.
