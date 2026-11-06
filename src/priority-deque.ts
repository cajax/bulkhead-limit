/**
 * Multi-level priority deque used as the limiter's wait queue.
 *
 * Items are grouped into per-priority buckets (doubly-linked lists), so:
 *  - enqueue is O(1) for an existing priority (O(log P) to create a new bucket);
 *  - dequeue from the highest-priority bucket is O(1);
 *  - unlinking a specific node (timeout / abort) is O(1), plus O(P) to drop its
 *    bucket when it becomes empty, where P is the number of distinct priorities.
 */

/** A task's context as stored in the queue. */
export interface QueueItem<T> {
    context: T;
    priority: number;
    enqueuedAt: number;
    timer?: ReturnType<typeof setTimeout>;
    detachAbort?: () => void;
    /**
     * `true` once the task has left the queue via ANY path (dispatch, timeout,
     * cancel). Guarantees exactly-once settlement: the race winner flips it and
     * the loser becomes a no-op.
     */
    settled: boolean;
    resolve: (release: () => void) => void;
    reject: (err: unknown) => void;
    node?: QueueNode<T>;
}

export interface QueueNode<T> {
    item: QueueItem<T>;
    prev: QueueNode<T> | null;
    next: QueueNode<T> | null;
    bucket?: PriorityBucket<T>;
}

/**
 * Internal bucket for a specific priority level.
 * All items in a bucket share identical priority and are processed in strict FIFO order.
 */
class PriorityBucket<T> {
    readonly priority: number;
    head: QueueNode<T> | null = null;
    tail: QueueNode<T> | null = null;
    size = 0;

    constructor(priority: number) {
        this.priority = priority;
    }

    push(item: QueueItem<T>): QueueNode<T> {
        const node: QueueNode<T> = { item, prev: this.tail, next: null, bucket: this };
        item.node = node;
        this.size++;

        if (this.tail) {
            this.tail.next = node;
            this.tail = node;
        } else {
            this.head = node;
            this.tail = node;
        }
        return node;
    }

    shift(): QueueItem<T> | undefined {
        if (!this.head) {
            return undefined;
        }

        const node = this.head;
        this.head = node.next;
        if (this.head) {
            this.head.prev = null;
        } else {
            this.tail = null;
        }

        this.size--;
        node.prev = null;
        node.next = null;
        node.bucket = undefined;
        node.item.node = undefined;
        return node.item;
    }

    remove(node: QueueNode<T>): void {
        if (node.prev) {
            node.prev.next = node.next;
        } else if (node === this.head) {
            this.head = node.next;
        }

        if (node.next) {
            node.next.prev = node.prev;
        } else if (node === this.tail) {
            this.tail = node.prev;
        }

        this.size--;
        node.prev = null;
        node.next = null;
        node.bucket = undefined;
        node.item.node = undefined;
    }
}

/**
 * High-performance multi-level Priority Deque.
 * Uses bucketed doubly-linked lists to ensure:
 * - O(1) enqueue for all items (Map lookup + tail append)
 * - O(1) dequeue from highest priority bucket
 * - O(1) unlinking on cancellation / queueTimeout
 */
export class PriorityDeque<T> {
    private buckets: PriorityBucket<T>[] = [];
    private bucketMap: Map<number, PriorityBucket<T>> = new Map();
    private _size = 0;

    get size(): number {
        return this._size;
    }

    get isEmpty(): boolean {
        return this._size === 0;
    }

    /**
     * Inserts an item into the deque respecting its priority.
     * Higher priority items precede lower priority items.
     * Items of identical priority preserve strict FIFO ordering.
     */
    insert(item: QueueItem<T>): QueueNode<T> {
        let bucket = this.bucketMap.get(item.priority);
        if (!bucket) {
            bucket = new PriorityBucket<T>(item.priority);
            this.bucketMap.set(item.priority, bucket);
            this.insertBucket(bucket);
        }

        const node = bucket.push(item);
        this._size++;
        return node;
    }

    private insertBucket(bucket: PriorityBucket<T>): void {
        // Fast-path: append if priority is smaller than or equal to lowest bucket
        if (this.buckets.length === 0 || bucket.priority <= this.buckets[this.buckets.length - 1].priority) {
            this.buckets.push(bucket);
            return;
        }

        // Fast-path: prepend if priority is higher than highest bucket
        if (bucket.priority > this.buckets[0].priority) {
            this.buckets.unshift(bucket);
            return;
        }

        // Binary search to insert in descending priority order
        let low = 0;
        let high = this.buckets.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.buckets[mid].priority > bucket.priority) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        this.buckets.splice(low, 0, bucket);
    }

    /**
     * Remove and return the highest priority item from the front of the queue in O(1) time.
     */
    shift(): QueueItem<T> | undefined {
        while (this.buckets.length > 0) {
            const highestBucket = this.buckets[0];
            const item = highestBucket.shift();
            if (item) {
                this._size--;
                if (highestBucket.size === 0) {
                    this.buckets.shift();
                    this.bucketMap.delete(highestBucket.priority);
                }
                return item;
            } else {
                this.buckets.shift();
                this.bucketMap.delete(highestBucket.priority);
            }
        }
        return undefined;
    }

    /**
     * Remove a specific node from anywhere in the queue in O(1) time (used for timeout and cancellation).
     * Returns true if the node was unlinked, false if already removed.
     */
    remove(node?: QueueNode<T>): boolean {
        if (!node || !node.bucket) return false;

        const bucket = node.bucket;
        bucket.remove(node);
        this._size--;

        if (bucket.size === 0) {
            this.bucketMap.delete(bucket.priority);
            const idx = this.buckets.indexOf(bucket);
            if (idx !== -1) {
                this.buckets.splice(idx, 1);
            }
        }
        return true;
    }

    /**
     * Clear all items from the queue and return them as an array.
     */
    clear(): QueueItem<T>[] {
        const items: QueueItem<T>[] = [];
        for (const bucket of this.buckets) {
            let curr = bucket.head;
            while (curr) {
                curr.item.node = undefined;
                items.push(curr.item);
                curr = curr.next;
            }
        }
        this.buckets = [];
        this.bucketMap.clear();
        this._size = 0;
        return items;
    }
}
