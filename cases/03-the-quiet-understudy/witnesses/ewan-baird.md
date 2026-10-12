# Statement: Ewan Baird, IT contractor

Taken 30 September 2026.

I rotate the cooperative's API credentials every quarter. On 8 September at about 14:00 I issued new keys for the availability service, updated the booking website and the ticket office terminals, and revoked the old keys. I tested the booking site afterwards and it was fine.

I did not know the assistant held its own copy of the availability key. It was set up by a different contractor in June and runs on a separate host. Nobody told me it needed updating and nothing alerted.

The availability service sits behind a gateway that answers 503 when it cannot authorise a request. I would have expected the assistant to fail loudly if its key stopped working.
