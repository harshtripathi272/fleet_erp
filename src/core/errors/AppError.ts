export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: unknown,
    public readonly isOperational = true,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = new.target.name;
  }
}
