export async function withDeadline<T>(operation: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Secure storage is unavailable. Please retry.")), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}
