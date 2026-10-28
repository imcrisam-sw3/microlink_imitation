import isAntibot from 'is-antibot';

export class AntibotDetector {
  check(input: isAntibot.Input): isAntibot.Result {
    return isAntibot(input);
  }
}
