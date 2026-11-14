/** Error with an HTTP status and a stable machine-readable code the apps can branch on. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, issues?: HttpError['issues']) => new HttpError(400, 'validation', message, issues);
export const unauthorized = (message = 'Sign in as the store owner to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, issues?: HttpError['issues']) => new HttpError(409, 'conflict', message, issues);
