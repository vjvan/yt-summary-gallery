import { getDb } from '../db';
import { getGlossary } from '../glossary-store';
import { requestLocalTranslation } from '../watch/local-translator';
import { localTranslationModel, processingMode } from '../watch/provider';
import { libraryJobActive } from '../pipeline/local-youtube-library';
import { subtitleWriteActive } from '../subtitle-writers';
import { SubtitleReviewService } from './service';
import { SubtitleReviewStore } from './store';

const runtime = globalThis as typeof globalThis & { __subtitleReviewServiceV1?: SubtitleReviewService };

export function getSubtitleReviewService(): SubtitleReviewService {
  if (!runtime.__subtitleReviewServiceV1) {
    const db = getDb();
    runtime.__subtitleReviewServiceV1 = new SubtitleReviewService({
      db, store: new SubtitleReviewStore(db), model: localTranslationModel, processingMode, glossary: getGlossary, request: requestLocalTranslation,
      jobActive: id => libraryJobActive(id) || subtitleWriteActive(id),
    });
  }
  return runtime.__subtitleReviewServiceV1;
}
