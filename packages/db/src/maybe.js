export function mapMaybe(value, mapper) {
  return value && typeof value.then === 'function' ? value.then(mapper) : mapper(value);
}

export function runMaybe(generatorFactory) {
  const iterator = generatorFactory();

  function advance(method, value) {
    let result;
    try {
      result = iterator[method](value);
    } catch (error) {
      throw error;
    }

    if (result.done) return result.value;
    const yielded = result.value;
    if (yielded && typeof yielded.then === 'function') {
      return yielded.then(
        resolved => advance('next', resolved),
        error => advance('throw', error)
      );
    }
    return advance('next', yielded);
  }

  return advance('next');
}