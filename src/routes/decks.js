import express from 'express';
import {
  getUserDecks,
  getDeckById,
  createDeck,
  updateDeck,
  deleteDeck,
  addCardToDeck,
  updateDeckCard,
  removeCardFromDeck,
  getDeckStats,
  createDeckShare,
  getDeckByShareToken,
  deleteDeckShare,
  importSharedDeck,
  checkDeckLegality,
} from '../services/deckService.js';
import { getDeckPrice } from '../services/pricingService.js';
import { parseDeckList, importDeck } from '../services/importService.js';
import {
  analyzeDeckPrintings,
  analyzeSpecificSet,
  applyPrintingOptimization,
  getAvailableSets,
} from '../services/printingOptimizerService.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/', authenticate, (req, res, next) => {
  try { res.json({ decks: getUserDecks(req.user.id) }); } catch (error) { next(error); }
});

router.post('/', authenticate, (req, res, next) => {
  try {
    const { name, format, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Deck name is required' });
    res.status(201).json({ deck: createDeck(req.user.id, name, format, description) });
  } catch (error) { next(error); }
});

router.post('/import', authenticate, (req, res, next) => {
  try {
    const { name, format, deckList } = req.body;
    if (!name || !deckList) return res.status(400).json({ error: 'Name and deck list are required' });
    const cardList = parseDeckList(deckList);
    if (!cardList.length) return res.status(400).json({ error: 'No valid cards found in deck list' });
    const result = importDeck(req.user.id, name, format, cardList);
    const deck = getDeckById(result.deckId, req.user.id);
    res.status(201).json({
      deck,
      imported: result.imported,
      notFound: result.notFound,
      message: `Successfully imported ${result.imported} cards${result.notFound > 0 ? ` (${result.notFound} not found)` : ''}`,
    });
  } catch (error) { next(error); }
});

// Public shared-deck routes must be declared before /:id routes.
router.get('/share/:token', optionalAuthenticate, (req, res, next) => {
  try {
    const deck = getDeckByShareToken(req.params.token);
    if (!deck) return res.status(404).json({ error: 'Shared deck not found or no longer available' });
    res.json({ deck, isAuthenticated: !!req.user });
  } catch (error) { next(error); }
});

router.post('/share/:token/import', authenticate, (req, res, next) => {
  try {
    res.status(201).json({ deck: importSharedDeck(req.params.token, req.user.id), message: 'Deck imported successfully' });
  } catch (error) { next(error); }
});

router.get('/:id', authenticate, (req, res, next) => {
  try {
    const deck = getDeckById(parseInt(req.params.id), req.user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    res.json({ deck });
  } catch (error) { next(error); }
});

router.put('/:id', authenticate, (req, res, next) => {
  try {
    const { name, format, description } = req.body;
    res.json({ deck: updateDeck(parseInt(req.params.id), req.user.id, { name, format, description }) });
  } catch (error) { next(error); }
});

router.delete('/:id', authenticate, (req, res, next) => {
  try {
    if (!deleteDeck(parseInt(req.params.id), req.user.id)) return res.status(404).json({ error: 'Deck not found' });
    res.json({ message: 'Deck deleted successfully' });
  } catch (error) { next(error); }
});

router.get('/:id/stats', authenticate, (req, res, next) => {
  try {
    const stats = getDeckStats(parseInt(req.params.id), req.user.id);
    if (!stats) return res.status(404).json({ error: 'Deck not found' });
    res.json(stats);
  } catch (error) { next(error); }
});

router.get('/:id/price', authenticate, (req, res, next) => {
  try {
    res.json(getDeckPrice(parseInt(req.params.id), req.user.id));
  } catch (error) { next(error); }
});

router.post('/:id/cards', authenticate, (req, res, next) => {
  try {
    const { printingId, quantity, isSideboard, isCommander, boardType } = req.body;
    if (!printingId) return res.status(400).json({ error: 'printingId is required' });
    const deck = addCardToDeck(
      parseInt(req.params.id),
      req.user.id,
      printingId,
      quantity || 1,
      isSideboard || false,
      isCommander || false,
      boardType
    );
    res.json({ deck });
  } catch (error) { next(error); }
});

router.put('/:id/cards/:cardId', authenticate, (req, res, next) => {
  try {
    const { quantity, isSideboard, isCommander, printingId, boardType } = req.body;
    const deck = updateDeckCard(parseInt(req.params.id), req.user.id, parseInt(req.params.cardId), {
      quantity,
      isSideboard,
      isCommander,
      printingId,
      boardType,
    });
    res.json({ deck });
  } catch (error) { next(error); }
});

router.delete('/:id/cards/:cardId', authenticate, (req, res, next) => {
  try {
    res.json({ deck: removeCardFromDeck(parseInt(req.params.id), req.user.id, parseInt(req.params.cardId)) });
  } catch (error) { next(error); }
});

router.post('/:id/share', authenticate, (req, res, next) => {
  try {
    const shareToken = createDeckShare(parseInt(req.params.id), req.user.id);
    res.json({ shareToken, shareUrl: `/share/${shareToken}` });
  } catch (error) { next(error); }
});

router.delete('/:id/share', authenticate, (req, res, next) => {
  try {
    if (!deleteDeckShare(parseInt(req.params.id), req.user.id)) return res.status(404).json({ error: 'Share link not found' });
    res.json({ message: 'Share link deleted successfully' });
  } catch (error) { next(error); }
});

router.get('/:id/legality/:format', authenticate, (req, res, next) => {
  try { res.json(checkDeckLegality(parseInt(req.params.id), req.user.id, req.params.format)); } catch (error) { next(error); }
});

router.get('/:id/optimize-printings', authenticate, (req, res, next) => {
  try {
    const topN = parseInt(req.query.topN) || 5;
    const excludeCommander = req.query.excludeCommander === 'true';
    res.json(analyzeDeckPrintings(parseInt(req.params.id), req.user.id, topN, excludeCommander));
  } catch (error) { next(error); }
});

router.get('/:id/optimize-printings/sets', authenticate, (req, res, next) => {
  try { res.json({ sets: getAvailableSets(parseInt(req.params.id), req.user.id) }); } catch (error) { next(error); }
});

router.post('/:id/optimize-printings/analyze-set', authenticate, (req, res, next) => {
  try {
    const { setCode } = req.body;
    if (!setCode) return res.status(400).json({ error: 'setCode is required' });
    const result = analyzeSpecificSet(parseInt(req.params.id), req.user.id, setCode);
    if (!result) return res.status(404).json({ error: 'No cards found for this set' });
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/optimize-printings/apply', authenticate, (req, res, next) => {
  try {
    const { changes } = req.body;
    if (!Array.isArray(changes) || !changes.length) return res.status(400).json({ error: 'changes array is required' });
    res.json(applyPrintingOptimization(parseInt(req.params.id), req.user.id, changes));
  } catch (error) { next(error); }
});

export default router;
