// Shared Hono environment: variables set on the context by requireUser.
export type AppEnv = {
  Variables: {
    userId: string;
    email: string;
  };
};
