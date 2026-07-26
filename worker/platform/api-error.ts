export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 500

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export class ApiError extends Error {
  readonly status: ApiStatus
  readonly code: string
  readonly details?: unknown

  constructor(
    status: ApiStatus,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const apiError = (
  status: ApiStatus,
  code: string,
  message: string,
  details?: unknown,
) => new ApiError(status, code, message, details)
