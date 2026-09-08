import express from 'express';
import {
  searchCardsForInventoryAdd,
  getOwnedSets,
} from '../services/inventoryService.js';
import {
  getInventoryFinishAware,
  getInventoryStatsFinishAware,
} from '../services/finishAwareInventoryService.js';
import { bulkAddToInventory } from '../services/inventoryBulkImportService.js';
import { setOwnedPrintingQuantityFinishAware } from '../services/finishAwareOwnershipService.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/inventory
 * Get paginated inventory list with filters
 */
router.get('/', authenticate, (req, res, next) => {
  try {
    const {
      name,
      colors,
      type,
      sets,
      sort,
      availability,
      page = 1,
      limit = 50
    } = req.query;

    const filters = {
      name,
      colors: colors ? colors.split(',') : [],
      type,
      sets: sets ? sets.split(',') : [],
      sort: sort || 'name',
      availability: availability || 'all',
      page: parseInt(page),
      limit: parseInt(limit)
    };

    const result = getInventoryFinishAware(req.user.id, filters);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/stats
 * Get collection statistics
 */
router.get('/stats', authenticate, (req, res, next) => {
  try {
    const stats = getInventoryStatsFinishAware(req.user.id);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/search
 * Quick-add search
 */
router.get('/search', authenticate, (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ cards: [] });
    }

    const cards = searchCardsForInventoryAdd(req.user.id, q, parseInt(limit));
    res.json({ cards });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/inventory/sets
 * Get sets that the user owns cards from
 */
router.get('/sets', authenticate, (req, res, next) => {
  try {
    const sets = getOwnedSets(req.user.id);
    res.json({ sets });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/bulk-add
 * Bulk import cards to inventory
 */
router.post('/bulk-add', authenticate, (req, res, next) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    const result = bulkAddToInventory(req.user.id, items);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/inventory/quick-add
 * Quick-add a single nonfoil card to inventory
 */
router.post('/quick-add', authenticate, (req, res, next) => {
  try {
    const { printingId, quantity = 1, finish = 'nonfoil' } = req.body;

    if (!printingId) {
      return res.status(400).json({ error: 'printingId is required' });
    }

    const result = setOwnedPrintingQuantityFinishAware(
      req.user.id,
      printingId,
      quantity,
      finish
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
