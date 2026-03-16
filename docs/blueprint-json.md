# Blueprint reference

Blueprints are JSON files that describe the desired initial state of a playground instance.

## Schema

The blueprint schema is defined in `assets/blueprints/blueprint-schema.json`.

## Structure

```json
{
  "siteTitle": "My Moodle",
  "locale": "en",
  "timezone": "Europe/Madrid",
  "admin": {
    "username": "admin",
    "password": "Admin1234!",
    "email": "admin@example.com"
  },
  "users": [],
  "categories": [],
  "courses": [],
  "landingPage": "/my/",
  "preferredVersions": {
    "php": "8.3",
    "moodle": "4.4"
  }
}
```

## Fields

### `siteTitle`

The Moodle site name displayed in the header.

- Type: `string`
- Default: `"Moodle Playground"`

### `locale`

Language code for the site.

- Type: `string`
- Default: `"en"`

### `timezone`

PHP/Moodle timezone.

- Type: `string`
- Default: `"UTC"`

### `admin`

Admin account credentials created during install.

| Field | Type | Default |
|-------|------|---------|
| `username` | `string` | `"admin"` |
| `password` | `string` | `"Admin1234!"` |
| `email` | `string` | `"admin@example.com"` |

### `users`

Array of extra user accounts to create after install.

```json
{
  "username": "teacher1",
  "password": "Teacher1!",
  "email": "teacher@example.com",
  "firstname": "Jane",
  "lastname": "Doe",
  "role": "editingteacher"
}
```

### `categories`

Array of course categories.

```json
{
  "name": "Science",
  "description": "Science courses"
}
```

### `courses`

Array of starter courses.

```json
{
  "fullname": "Introduction to Moodle",
  "shortname": "intro-moodle",
  "category": "Science"
}
```

### `landingPage`

The URL path to navigate to after boot.

- Type: `string`
- Default: `"/my/"`

### `preferredVersions`

Preferred PHP and Moodle versions. These can be overridden by URL parameters.

```json
{
  "php": "8.3",
  "moodle": "4.4"
}
```

## Import / Export

Blueprints can be exported and imported via the sidebar Settings tab:

- **Export**: downloads the current blueprint as a `.blueprint.json` file
- **Import**: loads a `.blueprint.json` file and resets the playground with the new configuration

## Default blueprint

The default blueprint is at `assets/blueprints/default.blueprint.json`. It configures a minimal Moodle site with an admin account.
