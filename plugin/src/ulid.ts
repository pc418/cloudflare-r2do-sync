const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

/**
 * ULID generator matching the server's `^[0-9A-HJKMNP-TV-Z]{26}$`. Monotonic within a
 * millisecond so a burst of commits still sorts in creation order.
 */
export function createUlidFactory(now: () => number = Date.now): () => string {
  let lastTime = -1;
  let lastRand: number[] = [];

  const randomChars = (): number[] => {
    const bytes = new Uint8Array(RAND_LEN);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b % 32);
  };

  const increment = (rand: number[]): number[] => {
    const next = [...rand];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i] < 31) {
        next[i]++;
        return next;
      }
      next[i] = 0;
    }
    return randomChars(); // exhausted the space in one millisecond; start fresh
  };

  return () => {
    const t = now();
    if (t === lastTime) {
      lastRand = increment(lastRand);
    } else {
      lastTime = t;
      lastRand = randomChars();
    }
    let time = "";
    let ms = t;
    for (let i = 0; i < TIME_LEN; i++) {
      time = CROCKFORD[ms % 32] + time;
      ms = Math.floor(ms / 32);
    }
    return time + lastRand.map((r) => CROCKFORD[r]).join("");
  };
}

export const ulid = createUlidFactory();
