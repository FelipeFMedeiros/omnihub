import { Elysia, t } from 'elysia';
import { AuthService, sessionCookie } from '../plugins/auth';
import { clientIp } from '../plugins/rate-limit';
import { requireTurnstile, type TurnstileVerifier } from '../plugins/turnstile';

const accountSchema = t.Object({
  user: t.Object({ id: t.String({ format: 'uuid' }), name: t.String(), email: t.String() }),
  workspace: t.Object({ id: t.String({ format: 'uuid' }), name: t.String() }),
  expiresAt: t.String({ format: 'date-time' }), csrfToken: t.String(),
});
const credentials = { email: t.String({ minLength: 1, maxLength: 320 }), password: t.String({ minLength: 1, maxLength: 128 }), turnstileToken: t.Optional(t.String({ maxLength: 2048 })) };
const errorSchema = t.Object({ error: t.Object({ code: t.String(), message: t.String() }) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 409: errorSchema, 415: errorSchema, 422: errorSchema, 429: errorSchema, 500: errorSchema, 503: errorSchema };

export function authRoutes(auth: AuthService, verifier: TurnstileVerifier) {
  return new Elysia({ prefix: '/api/auth' })
    .post('/register', async ({ request, body, set, server, status }) => {
      await requireTurnstile(verifier, body.turnstileToken, clientIp(request, server?.requestIP(request)?.address, auth.config), { action: 'register' });
      const issued = await auth.register(body);
      set.headers['Set-Cookie'] = sessionCookie(auth.config, issued.token);
      return status(201, issued.account);
    }, { body: t.Object({ ...credentials, name: t.String({ minLength: 1, maxLength: 120 }), password: t.String({ minLength: 12, maxLength: 128 }) }, { additionalProperties: false }),
      response: { ...errors, 201: accountSchema }, detail: { tags: ['Account'], summary: 'Criar conta e workspace vazio' } })
    .post('/login', async ({ request, body, set, server }) => {
      await requireTurnstile(verifier, body.turnstileToken, clientIp(request, server?.requestIP(request)?.address, auth.config), { action: 'login' });
      const issued = await auth.login(body);
      set.headers['Set-Cookie'] = sessionCookie(auth.config, issued.token);
      return issued.account;
    }, { body: t.Object(credentials, { additionalProperties: false }), response: { ...errors, 200: accountSchema }, detail: { tags: ['Account'], summary: 'Iniciar sessão curta' } })
    .get('/session', async ({ request }) => (await auth.authenticate(request)).account,
      { response: { ...errors, 200: accountSchema }, detail: { tags: ['Account'], security: [{ sessionCookie: [] }], summary: 'Consultar conta e CSRF da sessão' } })
    .post('/logout', async ({ request, set }) => {
      const session = await auth.authenticate(request);
      auth.requireCsrf(request, session);
      await auth.logout(session);
      set.headers['Set-Cookie'] = sessionCookie(auth.config, '', true);
      set.status = 204;
    }, { response: { ...errors, 204: t.Void() }, detail: { tags: ['Account'], security: [{ sessionCookie: [] }], summary: 'Revogar sessão e limpar cookie (204)' } });
}
