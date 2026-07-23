// src/security/errors.ts — typed errors for the security subsystem.

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityConfigError";
  }
}

export class SecurityAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityAuthorizationError";
  }
}

export class EngineLicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineLicenseError";
  }
}
