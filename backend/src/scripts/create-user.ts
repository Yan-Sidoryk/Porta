import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROLES, type Role } from '@gate/shared';
import { loadConfig } from '../config.js';
import { openDatabase } from '../infrastructure/db/open.js';
import { SqliteUserRepository } from '../infrastructure/db/user-repository.js';
import { hashPassword } from '../infrastructure/password.js';

/**
 * The only way an account comes into existence -- there is no signup route.
 * A door opener with a public registration endpoint is a door opener anyone
 * can register for, and the owner is the one person who must exist first.
 *
 * Usage:
 *   node --env-file=.env dist/scripts/create-user.js \
 *     --email you@example.com --password '...' --role owner
 *
 * The password is a command-line argument, so it lands in shell history and
 * in `ps` output on a shared machine. Run this on the host, as the service
 * user, and clear the history line afterwards.
 */
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string', default: 'user' },
  },
});

const usage = 'usage: create-user --email <email> --password <password> [--role owner|user]';

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

if (!values.email || !values.password) {
  console.error(usage);
  process.exit(1);
}
if (!isRole(values.role ?? '')) {
  console.error(`unknown role '${values.role}'. ${usage}`);
  process.exit(1);
}

const config = loadConfig(process.env);
const db = openDatabase(config.databasePath);
const users = new SqliteUserRepository(db);

const id = randomUUID();
try {
  await users.create({
    id,
    email: values.email,
    // Same argon2id helper the login path verifies with. A different hash
    // here would create an account that can never sign in.
    passwordHash: await hashPassword(values.password),
    role: values.role as Role,
    disabled: false,
    createdAt: new Date(),
  });
  console.log(id);
} catch (error) {
  // Almost always the UNIQUE constraint on email. Never print the error
  // verbatim: it echoes the row, password hash included.
  console.error(
    error instanceof Error && error.message.includes('UNIQUE')
      ? `a user with email ${values.email} already exists`
      : 'could not create the user',
  );
  process.exit(1);
} finally {
  db.close();
}
