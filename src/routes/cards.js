import express from 'express';
import { searchCards } from '../services/cardSearchService.js';
import {
  getCardById,
  getCardByName,
  getCardPrintings,
  getPrintingByUuid,
  getRandomCards,
  getCardStats,
  getAllSubtypes,
  browseCards,
  toggleCardOwnership,
  getUserOwnedCards,
  getCardOwnershipStatus,
  getCardOwnedPrintings,
  setOwnedPrintingQuantity,
  getCardOwnershipAndUsage,
} from '../services/cardService.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/browse', authenticate, (req, res, next) => {
  try {
    const { name, colors, type, rarities, sort, sets, subtypes, cmcMin, cmcMax, page = 1, limit = 50, onlyOwned } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    res.json(browseCards({
      name,
      colors: colors ? colors.split(',') : [],
      type,
      rarities: rarities ? rarities.split(',') : [],
      sort: sort || 'random',
      sets: sets ? sets.split(',') : [],
      subtypes: subtypes ? subtypes.split(',') : [],
      cmcMin: cmcMin ? parseInt(cmcMin) : null,
      cmcMax: cmcMax ? parseInt(cmcMax) : null,
      onlyOwned: onlyOwned === 'true',
      userId: req.user.id,
      limit: parseInt(limit),
      offset,
    }));
  } catch (error) { next(error); }
});

router.get('/search', authenticate, (req, res, next) => {
  try {
    const { q, limit, type } = req.query;
    if (!q || q.length < 2) return res.json({ cards: [] });
    res.json({ cards: searchCards(q, limit ? parseInt(limit) : 20, type || null) });
  } catch (error) { next(error); }
});

router.get('/random', authenticate, (req, res, next) => {
  try { res.json({ cards: getRandomCards(req.query.count ? parseInt(req.query.count) : 10) }); } catch (error) { next(error); }
});

router.get('/stats', authenticate, (req, res, next) => {
  try { res.json(getCardStats()); } catch (error) { next(error); }
});

router.get('/subtypes', authenticate, (req, res, next) => {
  try { res.json({ subtypes: getAllSubtypes() }); } catch (error) { next(error); }
});

router.get('/:id', authenticate, (req, res, next) => {
  try {
    const card = getCardById(parseInt(req.params.id));
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json({ card });
  } catch (error) { next(error); }
});

router.get('/:id/printings', authenticate, (req, res, next) => {
  try { res.json({ printings: getCardPrintings(parseInt(req.params.id)) }); } catch (error) { next(error); }
});

router.get('/name/:name', authenticate, (req, res, next) => {
  try {
    const card = getCardByName(req.params.name);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json({ card });
  } catch (error) { next(error); }
});

router.get('/printing/:uuid', authenticate, (req, res, next) => {
  try {
    const printing = getPrintingByUuid(req.params.uuid);
    if (!printing) return res.status(404).json({ error: 'Printing not found' });
    res.json({ printing });
  } catch (error) { next(error); }
});

router.post('/:id/owned', authenticate, (req, res, next) => {
  try { res.json(toggleCardOwnership(req.user.id, parseInt(req.params.id))); } catch (error) { next(error); }
});

router.get('/owned/all', authenticate, (req, res, next) => {
  try { res.json({ ownedCards: getUserOwnedCards(req.user.id) }); } catch (error) { next(error); }
});

router.get('/:id/owned', authenticate, (req, res, next) => {
  try { res.json(getCardOwnershipStatus(req.user.id, parseInt(req.params.id))); } catch (error) { next(error); }
});

router.get('/:id/ownership-usage', authenticate, (req, res, next) => {
  try { res.json(getCardOwnershipAndUsage(req.user.id, parseInt(req.params.id))); } catch (error) { next(error); }
});

router.post('/printings/:printingId/quantity', authenticate, (req, res, next) => {
  try {
    const printingId = parseInt(req.params.printingId);
    const { quantity } = req.body;
    if (quantity === undefined || quantity === null) return res.status(400).json({ error: 'Quantity is required' });
    res.json(setOwnedPrintingQuantity(req.user.id, printingId, parseInt(quantity)));
  } catch (error) { next(error); }
});

export default router;
