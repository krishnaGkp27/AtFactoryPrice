import 'package:cloud_firestore/cloud_firestore.dart';

/// Product Model
class Product {
  final String id;
  final String name;
  final String description;
  final double price;
  final String? unit;
  final String category;
  final String? categoryPath;
  final String imageUrl;
  final List<String> images;
  final bool wholesaleAvailable;
  final bool moqFriendly;
  final bool bulkDiscount;
  final bool bestSeller;
  final int? minQuantity;
  final bool inStock;
  final DateTime? createdAt;
  
  Product({
    required this.id,
    required this.name,
    required this.description,
    required this.price,
    this.unit,
    required this.category,
    this.categoryPath,
    required this.imageUrl,
    this.images = const [],
    this.wholesaleAvailable = false,
    this.moqFriendly = false,
    this.bulkDiscount = false,
    this.bestSeller = false,
    this.minQuantity,
    this.inStock = true,
    this.createdAt,
  });
  
  /// Create from Firestore document
  factory Product.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>;
    // Published products store category as {level1, level2, level3}
    // (functions publishCachedProducts); older docs store a plain string.
    // Parse both — a raw Map assigned to String would kill the whole
    // product-list mapping.
    final rawCat = data['category'];
    final String catLevel1 = rawCat is Map
        ? (rawCat['level1'] ?? '').toString()
        : (rawCat ?? '').toString();
    final String? catPath = rawCat is Map
        ? [rawCat['level1'], rawCat['level2'], rawCat['level3']]
            .where((l) => l != null && l.toString().isNotEmpty)
            .join(' > ')
        : data['categoryPath'] as String?;

    return Product(
      id: doc.id,
      name: data['name'] ?? '',
      description: data['description'] ?? '',
      price: (data['price'] ?? 0).toDouble(),
      unit: data['unit'] ?? data['pricingUnit'],
      category: catLevel1,
      categoryPath: catPath,
      imageUrl: data['imageUrl'] ?? data['image'] ?? '',
      images: List<String>.from(data['images'] ?? []),
      wholesaleAvailable: data['wholesaleAvailable'] == true,
      moqFriendly: data['moqFriendly'] == true,
      bulkDiscount: data['bulkDiscount'] == true,
      bestSeller: data['bestSeller'] == true,
      minQuantity: (data['minQuantity'] as num?)?.toInt(),
      inStock: data['inStock'] != false,
      createdAt: (data['createdAt'] as Timestamp?)?.toDate(),
    );
  }
  
  /// Create from JSON
  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      description: json['description'] ?? '',
      price: (json['price'] ?? 0).toDouble(),
      unit: json['unit'] ?? json['pricingUnit'],
      category: json['category'] ?? '',
      categoryPath: json['categoryPath'],
      imageUrl: json['imageUrl'] ?? json['image'] ?? '',
      images: List<String>.from(json['images'] ?? []),
      wholesaleAvailable: json['wholesaleAvailable'] == true,
      moqFriendly: json['moqFriendly'] == true,
      bulkDiscount: json['bulkDiscount'] == true,
      bestSeller: json['bestSeller'] == true,
      minQuantity: (json['minQuantity'] as num?)?.toInt(),
      inStock: json['inStock'] != false,
      createdAt: json['createdAt'] != null ? DateTime.tryParse(json['createdAt']) : null,
    );
  }
  
  /// Convert to JSON
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'price': price,
      'unit': unit,
      'category': category,
      'categoryPath': categoryPath,
      'imageUrl': imageUrl,
      'images': images,
      'wholesaleAvailable': wholesaleAvailable,
      'moqFriendly': moqFriendly,
      'bulkDiscount': bulkDiscount,
      'bestSeller': bestSeller,
      'minQuantity': minQuantity,
      'inStock': inStock,
      'createdAt': createdAt?.toIso8601String(),
    };
  }

  /// Shared NGN formatting with thousands separators — use everywhere a
  /// price renders so 'NGN 125,000' never sits next to 'NGN 125000'.
  static String formatPrice(num amount) => 'NGN ${amount.toStringAsFixed(0).replaceAllMapped(
    RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))'),
    (Match m) => '${m[1]},'
  )}';

  /// Get formatted price
  String get formattedPrice => formatPrice(price);
  
  /// Get price label with unit
  String get priceLabel => unit != null ? 'per $unit' : '';
}
