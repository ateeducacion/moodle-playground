function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createAdminAccountSyncPhp(adminConfig = {}) {
  const adminUsername =
    adminConfig.username && adminConfig.username !== "guest"
      ? escapePhpSingleQuoted(adminConfig.username)
      : null;
  const adminPassword = adminConfig.password
    ? escapePhpSingleQuoted(adminConfig.password)
    : null;
  const adminEmail = adminConfig.email
    ? escapePhpSingleQuoted(adminConfig.email)
    : null;

  const updates = [];
  if (adminUsername) {
    updates.push(`$admin->username = '${adminUsername}';`);
  }
  if (adminPassword) {
    updates.push(
      `$admin->password = hash_internal_user_password('${adminPassword}');`,
    );
  }
  if (adminEmail) {
    updates.push(`$admin->email = '${adminEmail}';`);
    updates.push(`set_config('supportemail', '${adminEmail}');`);
  }

  return `<?php
define('CLI_SCRIPT', true);
require('/www/moodle/config.php');
global $DB;
$admin = get_admin();
if (!$admin) {
    throw new RuntimeException('Unable to resolve the Moodle admin user.');
}
${updates.join("\n")}
$DB->update_record('user', $admin);
echo json_encode(['ok' => true, 'username' => $admin->username, 'email' => $admin->email]);
`;
}
