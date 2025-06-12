/**
 * VALIDATE: isArray
 */
function isArray(value: any): value is any[] {
  return Array.isArray(value);
}

/**
 * VALIDATE: isFunction
 */
function isFunction(value: any): value is Function {
  return typeof value === "function";
}

/**
 * DOT PRODUCT
 *
 * @param x        - first array
 * @param y        - second array
 * @param accessor - optional accessor `(element, index, arrayId) => number`
 * @returns        - dot product or null if empty
 */
function dot<T>(
  x: T[],
  y: T[],
  accessor?: (element: T, index: number, arrayId: number) => number,
): number | null {
  if (!isArray(x)) {
    throw new TypeError(
      `dot()::invalid input argument. First argument must be an array. Value: \`${x}\`.`,
    );
  }
  if (!isArray(y)) {
    throw new TypeError(
      `dot()::invalid input argument. Second argument must be an array. Value: \`${y}\`.`,
    );
  }
  if (accessor !== undefined && !isFunction(accessor)) {
    throw new TypeError(
      `dot()::invalid input argument. Accessor must be a function. Value: \`${accessor}\`.`,
    );
  }
  const len = x.length;
  if (len !== y.length) {
    throw new Error(
      "dot()::invalid input argument. Arrays must be of equal length.",
    );
  }
  if (len === 0) {
    return null;
  }
  let sum = 0;
  if (accessor) {
    for (let i = 0; i < len; i++) {
      sum += accessor(x[i]!, i, 0) * accessor(y[i]!, i, 1);
    }
  } else {
    for (let i = 0; i < len; i++) {
      sum += (x[i] as unknown as number) * (y[i] as unknown as number);
    }
  }
  return sum;
}

/**
 * L2 NORM
 *
 * @param arr      - input array
 * @param accessor - optional accessor `(element, index) => number`
 * @returns        - Euclidean norm or null if empty
 */
function l2norm<T>(
  arr: T[],
  accessor?: (element: T, index: number) => number,
): number | null {
  if (!isArray(arr)) {
    throw new TypeError(
      `l2norm()::invalid input argument. Must provide an array. Value: \`${arr}\`.`,
    );
  }
  if (accessor !== undefined && !isFunction(accessor)) {
    throw new TypeError(
      `l2norm()::invalid input argument. Accessor must be a function. Value: \`${accessor}\`.`,
    );
  }
  const len = arr.length;
  if (len === 0) {
    return null;
  }
  let t = 0;
  let s = 1;
  let r: number;
  for (let i = 0; i < len; i++) {
    const val = accessor ? accessor(arr[i]!, i) : (arr[i] as unknown as number);
    const abs = val < 0 ? -val : val;
    if (abs > 0) {
      if (abs > t) {
        r = t / val;
        s = 1 + s * r * r;
        t = abs;
      } else {
        r = val / t;
        s = s + r * r;
      }
    }
  }
  return t * Math.sqrt(s);
}

/**
 * Partially apply a 3-arg accessor to a 2-arg form by fixing arrayId.
 */
function partial<T>(
  fn: (el: T, i: number, arrayId: number) => number,
  arrayId: number,
): (el: T, i: number) => number {
  return (el, i) => fn(el, i, arrayId);
}

/**
 * COSINE SIMILARITY
 *
 * @param x        - first array
 * @param y        - second array
 * @param accessor - optional accessor `(element, index, arrayId) => number`
 * @returns        - cosine similarity or null if arrays are empty
 */
export default function similarity<T>(
  x: T[],
  y: T[],
  accessor?: (element: T, index: number, arrayId: number) => number,
): number | null {
  if (!isArray(x)) {
    throw new TypeError(
      `cosine-similarity()::invalid input argument. First argument must be an array. Value: \`${x}\`.`,
    );
  }
  if (!isArray(y)) {
    throw new TypeError(
      `cosine-similarity()::invalid input argument. Second argument must be an array. Value: \`${y}\`.`,
    );
  }
  if (accessor !== undefined && !isFunction(accessor)) {
    throw new TypeError(
      `cosine-similarity()::invalid input argument. Accessor must be a function. Value: \`${accessor}\`.`,
    );
  }
  if (x.length !== y.length) {
    throw new Error(
      "cosine-similarity()::invalid input argument. Input arrays must have the same length.",
    );
  }
  if (x.length === 0) {
    return null;
  }

  let a: number, b: number, c: number;

  if (accessor) {
    a = dot(x, y, accessor)!;
    b = l2norm(x, partial(accessor, 0))!;
    c = l2norm(y, partial(accessor, 1))!;
  } else {
    a = dot(x, y)!;
    b = l2norm(x)!;
    c = l2norm(y)!;
  }

  return a / (b * c);
}
