import { isbot } from 'isbot';

export class BotDetector {
  check(userAgent: string): boolean {
    return isbot(userAgent);
  }
}
