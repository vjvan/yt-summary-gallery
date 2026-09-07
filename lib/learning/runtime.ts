import { getDb } from '../db';
import { requestLocalTranslation } from '../watch/local-translator';
import { localTranslationModel } from '../watch/provider';
import { LearningService } from './service';
import { LearningStore } from './store';
import type { LearningSourceInput } from './source';
const runtime = globalThis as typeof globalThis & { __privateLearningServiceV1?: LearningService };
export function getLearningService(): LearningService {
  if (!runtime.__privateLearningServiceV1) {
    const db = getDb();
    runtime.__privateLearningServiceV1 = new LearningService({ store: new LearningStore(db), model: localTranslationModel, request: requestLocalTranslation,
      source: id => db.prepare('SELECT transcript,segments,title,transcript_source AS transcriptSource FROM summaries WHERE id=?').get(id) as LearningSourceInput | undefined,
    });
  }
  return runtime.__privateLearningServiceV1;
}
