// Model tests — pure Dart, no Firebase required, so `flutter test` runs
// clean on any machine. (Replaces the stock counter test, which referenced
// a MyApp widget this app never had and could not even compile.)

import 'package:flutter_test/flutter_test.dart';

import 'package:atfactoryprice/models/cart_item.dart';
import 'package:atfactoryprice/models/product.dart';

Product sampleProduct({double price = 125000}) => Product(
      id: 'p1',
      name: 'Cashmere Bale',
      description: '60 yards premium',
      price: price,
      unit: 'bale',
      category: 'Cashmere',
      imageUrl: 'https://example.com/p1.jpg',
      minQuantity: 2,
      createdAt: DateTime.parse('2026-07-01T10:00:00Z'),
    );

void main() {
  test('Product JSON round-trip keeps every field (incl. createdAt)', () {
    final p = sampleProduct();
    final back = Product.fromJson(p.toJson());
    expect(back.id, p.id);
    expect(back.name, p.name);
    expect(back.price, p.price);
    expect(back.unit, p.unit);
    expect(back.minQuantity, p.minQuantity);
    expect(back.createdAt, p.createdAt);
  });

  test('fromJson tolerates alternate field names and numeric doubles', () {
    final p = Product.fromJson({
      'id': 'p2',
      'name': 'Chinos',
      'description': '',
      'price': 90000,
      'pricingUnit': 'bale', // legacy name for unit
      'image': 'https://example.com/p2.jpg', // legacy name for imageUrl
      'category': 'Chinos',
      'minQuantity': 10.0, // double from an admin tool must not throw
    });
    expect(p.unit, 'bale');
    expect(p.imageUrl, 'https://example.com/p2.jpg');
    expect(p.minQuantity, 10);
  });

  test('formatPrice groups thousands consistently', () {
    expect(Product.formatPrice(125000), 'NGN 125,000');
    expect(Product.formatPrice(1500), 'NGN 1,500');
    expect(Product.formatPrice(950), 'NGN 950');
    expect(sampleProduct().formattedPrice, 'NGN 125,000');
  });

  test('CartItem math and JSON round-trip', () {
    final item = CartItem(product: sampleProduct(), quantity: 3);
    expect(item.total, 375000);
    final back = CartItem.fromJson(item.toJson());
    expect(back.quantity, 3);
    expect(back.product.id, 'p1');
    expect(back.total, item.total);
  });
}
